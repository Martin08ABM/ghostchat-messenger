# IMPORTS
from .config import DATABASE_PATH, ID_LENGTH, MESSAGES_PER_SECOND, MAX_FILE_SIZE_MB, CHUNKS_PER_SECOND, MAX_CONNECTIONS, KEY_EXCHANGE_PER_SECOND
from .validation import validate_message, MessageTypes
from .rate_limit import check_rate_limit, get_client_ip, RATE_LIMITS, init_rate_limit_db, cleanup_old_entries
from .app_logging import setup_logging, metrics
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import aiosqlite
import secrets
import string
from contextlib import asynccontextmanager
import json
import time
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import asyncio

# Setup structured logging
logger = setup_logging("INFO")

# DATABASE
# Create the users table on first run
async def init_db():
  async with aiosqlite.connect(DATABASE_PATH) as db:
    await db.execute(f"""
      CREATE TABLE IF NOT EXISTS users (
        id CHAR({ID_LENGTH}) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    """)
    await db.commit()

# Generate a unique user ID, persist it, and return it
async def generate_unique_id():
  alphabet = string.ascii_letters + string.digits

  async with aiosqlite.connect(DATABASE_PATH) as db:
    while True:
      user_id = ''.join(secrets.choice(alphabet) for i in range(ID_LENGTH))
      cursor = await db.execute("""
        SELECT id FROM users WHERE id = ?""",
        (user_id,)
      )
      row = await cursor.fetchone()
      if row is None:
        await db.execute("INSERT INTO users (id) VALUES (?)", (user_id,))
        await db.commit()
        return user_id  

# Delete a user ID from the database
async def delete_id(user_id: str):
  async with aiosqlite.connect(DATABASE_PATH) as db:
    await db.execute("""
      DELETE FROM users WHERE id = ?""",
      (user_id,)
    )
    await db.commit()

# Delete all user IDs — called on startup since a server restart invalidates all sessions
async def cleanup_all_ids():
  async with aiosqlite.connect(DATABASE_PATH) as db:
    await db.execute("DELETE FROM users")
    await db.commit()
  logger.info("event=cleanup_ids status=completed")

# Check if a user ID exists in the database
async def id_exists(user_id: str):
  async with aiosqlite.connect(DATABASE_PATH) as db:
      cursor = await db.execute("""
        SELECT id FROM users WHERE id = ?""",
        (user_id,)
      )
      row = await cursor.fetchone()
      
      if row is None:
        return False
      else:
        return True

# CONNECTION MANAGER
# Active WebSocket connections keyed by user ID
active_connections: dict[str, WebSocket] = {}
# Last message timestamp per user, used for rate limiting
last_message_time: dict[str, float] = {}
# Last file chunk timestamp per user, used for chunk rate limiting
last_chunk_time: dict[str, float] = {}
# Last key_exchange timestamp per user, used for key exchange rate limiting
last_key_exchange_time: dict[str, float] = {}

# Send a JSON message to a connected user; returns False if not reachable
async def send_to_user(user_id, message):
  websocket = active_connections.get(user_id)

  if websocket is None:
    return False
  else:
    try:
      await websocket.send_json(message)
      return True
    except Exception as e:
      logger.error("event=send_failed", user_id=user_id, error=str(e))
      return False

# APP
# Initialize the database on startup
@asynccontextmanager
async def lifespan(app: FastAPI):
  await init_db()
  await init_rate_limit_db()
  await cleanup_all_ids()
  logger.info("event=startup status=completed")
  yield
  logger.info("event=shutdown status=completed")

app = FastAPI(lifespan=lifespan)

# CSP Middleware
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
  """Add Content Security Policy and other security headers"""
  response = await call_next(request)
  response.headers["Content-Security-Policy"] = (
    "default-src 'self'; "
    "script-src 'self' https://cdnjs.cloudflare.com https://cloud.umami.is; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' blob: data:; "
    "connect-src 'self' ws: wss:; "
    "font-src 'self' data:; "
    "object-src 'none'; "
    "media-src 'self' blob:; "
  )
  response.headers["X-Content-Type-Options"] = "nosniff"
  response.headers["X-Frame-Options"] = "DENY"
  response.headers["X-XSS-Protection"] = "1; mode=block"
  response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
  return response

# Metrics endpoint
@app.get("/metrics")
async def get_metrics():
  """Devuelve métricas actuales del servidor"""
  return metrics.get_stats()

# Health check endpoint
@app.get("/health")
async def health_check():
  """Health check para orchestration"""
  return {"status": "healthy", "timestamp": time.time()}

# WebSocket endpoint — all client communication flows through here
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    client_ip = get_client_ip(websocket)
    
    # Connection rate limit
    allowed, retry_after = await check_rate_limit(
        client_ip, "connections", 
        RATE_LIMITS["connections"]["max"], 
        RATE_LIMITS["connections"]["window"]
    )
    
    if not allowed:
        logger.warning("event=rate_limit_hit", ip=client_ip, limit_type="connections")
        metrics.increment("rate_limits_hit")
        await websocket.close(code=1013, reason="Too many connections")
        return
    
    # Max connections check
    if len(active_connections) >= MAX_CONNECTIONS:
        logger.warning("event=max_connections_exceeded", active=len(active_connections), max=MAX_CONNECTIONS)
        await websocket.close(code=1013, reason="Server at capacity")
        return
    
    await websocket.accept()
    user_id = None
    
    logger.info("event=websocket_connected", client_ip=client_ip, active_connections=len(active_connections) + 1)
    metrics.increment("connections_total")
    metrics.connections_active = len(active_connections) + 1
    
    try:
      while True:
        raw_data = await websocket.receive_text()
        
        try:
          data = json.loads(raw_data)
        except json.JSONDecodeError:
          logger.warning("event=invalid_json", ip=client_ip, user_id=user_id)
          await websocket.send_json({"type": "error", "message": "Invalid JSON"})
          continue
        
        # Validar mensaje con Pydantic
        validated_msg, error = validate_message(data)
        if error:
          logger.warning("event=validation_failed", ip=client_ip, user_id=user_id, error=error)
          await websocket.send_json({"type": "error", "message": error})
          continue
        
        msg_type = validated_msg.type
        
        # Rate limiting por tipo de mensaje
        if hasattr(validated_msg, 'to') and validated_msg.to:
            limit_type = None
            if msg_type == "text":
                limit_type = "messages"
            elif msg_type == "file_chunk":
                limit_type = "chunks"
            elif msg_type == "key_exchange":
                limit_type = "key_exchange"
            
            if limit_type:
                allowed, retry_after = await check_rate_limit(
                    client_ip, limit_type,
                    RATE_LIMITS[limit_type]["max"],
                    RATE_LIMITS[limit_type]["window"]
                )
                
                if not allowed:
                    logger.warning("event=rate_limit_hit", client_ip=client_ip, limit_type=limit_type, user_id=user_id)
                    metrics.increment("rate_limits_hit")
                    await websocket.send_json({
                        "type": "error", 
                        "message": f"Rate limit exceeded. Retry after {retry_after}s"
                    })
                    continue
        
        # Register a new user and send back the generated ID
        if msg_type == "register":
          generated_id = await generate_unique_id()
          active_connections[generated_id] = websocket
          await websocket.send_json({"type": "registered", "id": generated_id})
          user_id = generated_id
          logger.info("event=user_registered", user_id=generated_id, ip=client_ip)
          
        # Log in with an existing ID
        elif msg_type == "login":
          exists = await id_exists(validated_msg.id)
          
          if not exists:
              logger.warning("event=login_failed", reason="id_not_found", user_id=validated_msg.id, client_ip=client_ip)
              await websocket.send_json({"type": "error", "message": "ID not found"})
          elif validated_msg.id in active_connections:
              logger.warning("event=login_failed", reason="already_active", user_id=validated_msg.id, client_ip=client_ip)
              await websocket.send_json({"type": "error", "message": "This session is active"})
          else:
              active_connections[validated_msg.id] = websocket
              await websocket.send_json({"type": "logged_in", "id": validated_msg.id})
              user_id = validated_msg.id
              logger.info("event=user_logged_in", user_id=validated_msg.id, client_ip=client_ip)
        
        # Replace the current user ID with a new one
        elif msg_type == "refresh_id":
          if user_id is None:
            continue
          
          old_id = user_id
          active_connections.pop(user_id)
          await delete_id(str(user_id))
          new_user_id = await generate_unique_id()
          active_connections[new_user_id] = websocket
          user_id = new_user_id
          await websocket.send_json({"type": "id_refreshed", "id": new_user_id})
          logger.info("event=id_refreshed", old_id=old_id, new_id=new_user_id, client_ip=client_ip)
        
        # Forward an encrypted text message to the recipient
        elif msg_type == "text":
          if user_id is None:
            continue
          
          to = validated_msg.to
          message = {
              "type": "sended",
              "from": user_id,
              "payload": validated_msg.payload,
              "nonce": validated_msg.nonce,
              "timestamp": time.time(),
          }
          try:
            sended = await send_to_user(to, message)
            if sended:
              await websocket.send_json({"type": "delivery_status", "delivered": True})
              logger.info("event=message_sent", sender=user_id, recipient=to, delivered=True)
              metrics.increment("messages_processed")
            else:
              await websocket.send_json({"type": "delivery_status", "delivered": False})
              logger.info("event=message_sent", sender=user_id, recipient=to, delivered=False)
          except Exception as e:
            logger.error("event=message_send_error", sender=user_id, recipient=to, error=str(e))
            metrics.increment("messages_failed")
            await websocket.send_json({"type": "error", "message": "There was an error"})
        
        # Forward a public key to the recipient to establish E2E encryption
        elif msg_type == "key_exchange":
          if user_id is None:
            continue
          
          to = validated_msg.to
          message = {
            "type": "key_exchange",
            "from": user_id,
            "payload": validated_msg.payload,
          }
          delivered = await send_to_user(to, message)
          await websocket.send_json({"type": "delivery_status", "delivered": delivered})
          logger.info("event=key_exchange", sender=user_id, recipient=to, delivered=delivered)
        
        # Forward encrypted file metadata to the recipient
        elif msg_type == "file_meta":
          if user_id is None:
            continue
          
          if validated_msg.size > MAX_FILE_SIZE_MB * 1024 * 1024:
            logger.warning("event=file_too_large", user_id=user_id, file_size=validated_msg.size, limit_mb=MAX_FILE_SIZE_MB)
            await websocket.send_json({"type": "error", "message": f"File exceeds the {MAX_FILE_SIZE_MB} MB limit"})
            continue
          
          to = validated_msg.to
          delivered = await send_to_user(to, {
            "type": "file_meta",
            "from": user_id,
            "transferId": validated_msg.transferId,
            "payload": validated_msg.payload,
            "nonce": validated_msg.nonce,
          })
          await websocket.send_json({"type": "delivery_status", "delivered": delivered})
          logger.info("event=file_meta_sent", sender=user_id, recipient=to, transfer_id=validated_msg.transferId)
          metrics.increment("file_transfers")
        
        # Forward an encrypted file chunk to the recipient
        elif msg_type == "file_chunk":
          if user_id is None:
            continue
          
          to = validated_msg.to
          await send_to_user(to, {
            "type": "file_chunk",
            "from": user_id,
            "transferId": validated_msg.transferId,
            "index": validated_msg.index,
            "total": validated_msg.total,
            "payload": validated_msg.payload,
            "nonce": validated_msg.nonce,
          })
        
        # Notify the sender that the transfer was accepted or rejected
        elif msg_type in ("file_accept", "file_reject"):
          if user_id is None:
            continue
          await send_to_user(validated_msg.to, {
            "type": msg_type,
            "from": user_id,
            "transferId": validated_msg.transferId,
          })
          logger.info("event=file_transfer_response", sender=user_id, recipient=validated_msg.to, action=msg_type)
        
        # Forward a typing indicator to the recipient
        elif msg_type == "typing":
          if user_id is None:
            continue
          await send_to_user(validated_msg.to, {"type": "typing", "from": user_id})
        
        # Clean disconnect: remove connection and close the loop
        elif msg_type == "disconnect":
          if user_id is None:
            continue
          
          logger.info("event=user_disconnected", user_id=user_id, client_ip=client_ip, reason="clean")
          del active_connections[user_id]
          metrics.connections_active = len(active_connections)
          user_id = None
          break
        
        # Keepalive ping
        elif msg_type == "ping":
          await websocket.send_json({"type": "pong"})
    
    except WebSocketDisconnect:
      if user_id:
          logger.info("event=user_disconnected", user_id=user_id, client_ip=client_ip, reason="websocket_disconnect")
    except json.JSONDecodeError:
      logger.warning("event=invalid_json", client_ip=client_ip, user_id=user_id)
    except Exception as e:
      logger.error("event=websocket_error", user_id=user_id, client_ip=client_ip, error=str(e))
    
    finally:
        # Always clean up on disconnect, whether graceful or not
        if user_id and user_id in active_connections:
            del active_connections[user_id]
            metrics.connections_active = len(active_connections)

# Frontend static file serving
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

@app.get("/")
async def serve_index():
    return FileResponse(FRONTEND_DIR/"index.html")

@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse(FRONTEND_DIR/"manifest.json", media_type="application/manifest+json")

@app.get("/sw.js")
async def serve_sw():
    return FileResponse(FRONTEND_DIR/"sw.js", media_type="application/javascript")

app.mount("/css", StaticFiles(directory=FRONTEND_DIR/"css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR/"js"), name="js")
app.mount("/icons", StaticFiles(directory=FRONTEND_DIR/"icons"), name="icons")

# Cleanup task for rate limit database
@app.on_event("startup")
async def start_cleanup_task():
  async def cleanup_loop():
    while True:
      try:
        # Limpiar entradas de rate limiting mayores a 1 hora
        await cleanup_old_entries(3600)
        await asyncio.sleep(3600)  # Cada hora
      except Exception as e:
        logger.error("event=cleanup_error", error=str(e))
  
  # No bloquear el startup
  asyncio.create_task(cleanup_loop())

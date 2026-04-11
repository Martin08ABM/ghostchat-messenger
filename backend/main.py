# IMPORTATIONS
from .config import DATABASE_PATH, ID_LENGTH, MESSAGES_PER_SECOND
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import aiosqlite
import secrets
import string
from contextlib import asynccontextmanager
import json
import time
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

# DATABASE
# Create the table users
async def init_db():
  async with aiosqlite.connect(DATABASE_PATH) as db:
    await db.execute(f"""
      CREATE TABLE IF NOT EXISTS users (
        id CHAR({ID_LENGTH}) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    """)
    await db.commit()

# Generate the random id
async def generate_unique_id():
  alphabet = string.ascii_letters + string.digits
  
  # Connect to the database for check if the generated id is repeated
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

# Delete the id
async def delete_id(user_id: str):
  async with aiosqlite.connect(DATABASE_PATH) as db:
    await db.execute("""
      DELETE FROM users WHERE id = ?""",
      (user_id,)
    )
    await db.commit()

# Check if the id exists
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

# MESSAGE VALIDATION
def validate_message(data):
  messages_types = [
    "register", "login", "refresh_id", "text", "ping",
    "key_exchange", "disconnect", "typing",
    "file_meta", "file_chunk", "file_accept", "file_reject",
  ]

  if "type" not in data:
    return "The message don't have a type"
  elif data["type"] not in messages_types:
    return "The message type is not accepted"
  elif data["type"] == "login" and "id" not in data:
    return "There was a problem with the message type"
  elif data["type"] == "text" and ("to" not in data or "payload" not in data or "nonce" not in data):
    return "There was a problem with the message type"
  elif data["type"] == "key_exchange" and ("to" not in data or "payload" not in data):
    return "There was a problem with the message type"
  elif data["type"] == "typing" and "to" not in data:
    return "There was a problem with the message type"
  elif data["type"] == "file_meta" and ("to" not in data or "transferId" not in data or "payload" not in data or "nonce" not in data):
    return "There was a problem with the message type"
  elif data["type"] == "file_chunk" and ("to" not in data or "transferId" not in data or "index" not in data or "total" not in data or "payload" not in data or "nonce" not in data):
    return "There was a problem with the message type"
  elif data["type"] in ("file_accept", "file_reject") and ("to" not in data or "transferId" not in data):
    return "There was a problem with the message type"
  else:
    return None

# CONECTION MANAGER
# Dictrionary to save the active connections
active_connections: dict[str, WebSocket] = {}
last_message_time: dict[str, float] = {}

async def send_to_user(user_id, message):
  websocket = active_connections.get(user_id)
  
  if websocket is None:
    return False
  else:
    try:
      await websocket.send_json(message)
      return True
    except:
      return False

# FastAPI App
# The lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
  await init_db()
  yield

# Start the FastAPI server
app = FastAPI(lifespan=lifespan)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    user_id = None
    
    try:
      while True:
        data = await websocket.receive_json()
        
        error = validate_message(data)
        if error is not None:
            await websocket.send_json({"type": "error", "message": error})
            continue
        
        msg_type = data["type"]

        #  Register a new user
        if msg_type == "register":
          generated_id = await generate_unique_id()
          active_connections[generated_id] = websocket

          await websocket.send_json({"type": "registered", "id": generated_id})
          user_id = generated_id
          
        # Login a user
        elif msg_type == "login":
          exists = await id_exists(data["id"])

          if not exists:
              await websocket.send_json({"type": "error", "message": "ID not found"})
          elif data["id"] in active_connections:
              await websocket.send_json({"type": "error", "message": "This sessions is active"})
          else:
              active_connections[data["id"]] = websocket
              await websocket.send_json({"type": "logged_in", "id": data["id"]})
              user_id = data["id"]
    
        # Refresh the id
        elif msg_type == "refresh_id":
          if user_id is None:
            continue
          
          active_connections.pop(user_id)
          await delete_id(str(user_id))
          new_user_id = await generate_unique_id()
          active_connections[new_user_id] = websocket
          user_id = new_user_id
          await websocket.send_json({"type": "id_refreshed", "id": new_user_id})
      
        elif msg_type == "text":
          if user_id is None:
            continue

          now = time.time()
          last = last_message_time.get(user_id, 0)
          if now - last < 1 / MESSAGES_PER_SECOND:
            await websocket.send_json({"type": "error", "message": "Rate limit exceeded"})
            continue
          last_message_time[user_id] = now

          to = data["to"]
          data.pop("to")
            
          message = {
              "type": "sended",
              "from": user_id,
              "payload": data.get("payload", ""),
              "nonce": data.get("nonce", ""),
              "timestamp": time.time(),
          }
          try:
            sended = await send_to_user(to, message)

            if sended is True:
              await websocket.send_json({"type": "delivery_status", "delivered": True})
            else:
              await websocket.send_json({"type": "delivery_status", "delivered": False})
          except:
            await websocket.send_json({"type": "error", "message": "There was an error"})
            
          del to, message, data
            
        elif msg_type == "key_exchange":
          if user_id is None:
            continue

          to = data["to"]
          message = {
            "type": "key_exchange",
            "from": user_id,
            "payload": data.get("payload", ""),
          }
          delivered = await send_to_user(to, message)
          await websocket.send_json({"type": "delivery_status", "delivered": delivered})

        elif msg_type == "file_meta":
          if user_id is None:
            continue
          to = data["to"]
          delivered = await send_to_user(to, {
            "type": "file_meta",
            "from": user_id,
            "transferId": data["transferId"],
            "payload": data["payload"],
            "nonce": data["nonce"],
          })
          await websocket.send_json({"type": "delivery_status", "delivered": delivered})

        elif msg_type == "file_chunk":
          if user_id is None:
            continue
          to = data["to"]
          await send_to_user(to, {
            "type": "file_chunk",
            "from": user_id,
            "transferId": data["transferId"],
            "index": data["index"],
            "total": data["total"],
            "payload": data["payload"],
            "nonce": data["nonce"],
          })

        elif msg_type in ("file_accept", "file_reject"):
          if user_id is None:
            continue
          await send_to_user(data["to"], {
            "type": msg_type,
            "from": user_id,
            "transferId": data["transferId"],
          })

        elif msg_type == "typing":
          if user_id is None:
            continue
          await send_to_user(data["to"], {"type": "typing", "from": user_id})

        elif msg_type == "disconnect":
          if user_id is None:
            continue

          del active_connections[user_id]
          user_id = None
          break

        elif msg_type == "ping":
          await websocket.send_json({"type": "pong"})
      
    except WebSocketDisconnect:
      pass
    except json.JSONDecodeError:
      pass
      
    finally:
        if user_id in active_connections:
            del active_connections[user_id]
        if user_id in last_message_time:
            del last_message_time[user_id]

# Set the frontend routes
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
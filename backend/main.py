# IMPORTATIONS
from .config import HOST, PORT, DATABASE_PATH, ID_LENGTH, MESSAGES_PER_SECOND
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
        id CHAR({ID_LENGTH}) PRIMARY KEY
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

# CONECTION MANAGER
# Dictrionary to save the active connections
active_connections = {}

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
          
          to = data["to"]
          data.pop("to")
            
          message = {
            "type": "sended",
            "from": user_id,
            "payload": data.get("payload", ""),
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
            
        elif msg_type == "ping":
          await websocket.send_json({"type": "pong"})
      
    except WebSocketDisconnect:
      pass
    except json.JSONDecodeError:
      pass
      
    finally:
        if user_id in active_connections:
            del active_connections[user_id]

# Set the frontend routes
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

@app.get("/")
async def serve_index():
    return FileResponse(FRONTEND_DIR/"index.html")

app.mount("/css", StaticFiles(directory=FRONTEND_DIR/"css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR/"js"), name="js")
# IMPORTATIONS
from .config import HOST, PORT, DATABASE_PATH, ID_LENGTH, MESSAGES_PER_SECOND
import fastapi
import uvicorn
import aiosqlite
import secrets
import string

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

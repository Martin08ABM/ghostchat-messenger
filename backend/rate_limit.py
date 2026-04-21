"""
Rate limiting persistente por IP usando SQLite.
Soporta múltiple tipos de rate limits (mensajes, chunks, key_exchange).
"""
import time
import aiosqlite
import asyncio
from typing import Optional

RATE_LIMIT_DB = "rate_limits.db"

async def init_rate_limit_db():
    """Inicializa la base de datos de rate limits"""
    async with aiosqlite.connect(RATE_LIMIT_DB) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS rate_limits (
                ip TEXT NOT NULL,
                limit_type TEXT NOT NULL,
                window_start REAL NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (ip, limit_type, window_start)
            )
        """)
        
        # Índice para limpieza eficiente
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_rate_limits_time 
            ON rate_limits(window_start)
        """)
        
        await db.commit()

async def cleanup_old_entries(window_seconds: int):
    """Limpia entradas antiguas del rate limiting"""
    cutoff = time.time() - window_seconds
    async with aiosqlite.connect(RATE_LIMIT_DB) as db:
        await db.execute("DELETE FROM rate_limits WHERE window_start < ?", (cutoff,))
        await db.commit()

async def check_rate_limit(
    ip: str, 
    limit_type: str, 
    max_requests: int, 
    window_seconds: int
) -> tuple[bool, Optional[int]]:
    """
    Verifica si una IP está dentro del rate limit.
    
    Returns:
        (allowed: bool, retry_after: Optional[int])
        retry_after es segundos hasta que se permita la siguiente petición
    """
    now = time.time()
    window_start = int(now / window_seconds) * window_seconds
    
    async with aiosqlite.connect(RATE_LIMIT_DB) as db:
        # Obtener o crear entrada
        cursor = await db.execute("""
            SELECT count FROM rate_limits 
            WHERE ip = ? AND limit_type = ? AND window_start = ?
        """, (ip, limit_type, window_start))
        
        row = await cursor.fetchone()
        
        if row is None:
            # Primera petición en esta ventana
            await db.execute("""
                INSERT INTO rate_limits (ip, limit_type, window_start, count)
                VALUES (?, ?, ?, 1)
            """, (ip, limit_type, window_start))
            await db.commit()
            return True, None
        
        current_count = row[0]
        
        if current_count >= max_requests:
            # Calcular cuándo se resetea la ventana
            reset_time = window_start + window_seconds
            retry_after = int(reset_time - now) + 1
            return False, retry_after
        
        # Incrementar contador
        await db.execute("""
            UPDATE rate_limits 
            SET count = count + 1 
            WHERE ip = ? AND limit_type = ? AND window_start = ?
        """, (ip, limit_type, window_start))
        await db.commit()
        return True, None

# Rate limit configuration
RATE_LIMITS = {
    "messages": {"max": 10, "window": 1},      # 10 msg/s
    "chunks": {"max": 100, "window": 1},       # 100 chunks/s
    "key_exchange": {"max": 2, "window": 1},   # 2 key exchanges/s
    "connections": {"max": 5, "window": 60},   # 5 conexiones por minuto
}

def get_client_ip(websocket) -> str:
    """Extrae la IP del cliente del WebSocket"""
    # FastAPI/Starlette guarda la IP en headers
    client = websocket.client
    if client:
        return f"{client.host}:{client.port}"
    
    # Fallback a headers (si está detrás de proxy)
    headers = dict(websocket.headers)
    forwarded = headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    
    real_ip = headers.get("x-real-ip")
    if real_ip:
        return real_ip
    
    return "unknown"

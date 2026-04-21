import pydantic
from typing import Optional, Literal, Any

class BaseMessage(pydantic.BaseModel):
    type: str

class RegisterMessage(BaseMessage):
    type: Literal["register"]

class LoginMessage(BaseMessage):
    type: Literal["login"]
    id: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)

class RefreshIdMessage(BaseMessage):
    type: Literal["refresh_id"]

class TextMessage(BaseMessage):
    type: Literal["text"]
    to: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)
    payload: str
    nonce: str
    timestamp: Optional[int] = None

class KeyExchangeMessage(BaseMessage):
    type: Literal["key_exchange"]
    to: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)
    payload: str

class TypingMessage(BaseMessage):
    type: Literal["typing"]
    to: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)

class FileMetaMessage(BaseMessage):
    type: Literal["file_meta"]
    to: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)
    transferId: str = pydantic.Field(pattern=r"^[a-f0-9]+$", min_length=4, max_length=64)
    payload: str
    nonce: str
    size: int = pydantic.Field(ge=0, le=100*1024*1024)  # Max 100MB

class FileChunkMessage(BaseMessage):
    type: Literal["file_chunk"]
    to: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)
    transferId: str = pydantic.Field(pattern=r"^[a-f0-9]+$", min_length=4, max_length=64)
    index: int = pydantic.Field(ge=0)
    total: int = pydantic.Field(ge=1)
    payload: str
    nonce: str

class FileAcceptMessage(BaseMessage):
    type: Literal["file_accept"]
    to: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)
    transferId: str = pydantic.Field(pattern=r"^[a-f0-9]+$", min_length=4, max_length=64)

class FileRejectMessage(BaseMessage):
    type: Literal["file_reject"]
    to: str = pydantic.Field(pattern=r"^[a-zA-Z0-9]+$", min_length=8, max_length=32)
    transferId: str = pydantic.Field(pattern=r"^[a-f0-9]+$", min_length=4, max_length=64)

class DisconnectMessage(BaseMessage):
    type: Literal["disconnect"]

class PingMessage(BaseMessage):
    type: Literal["ping"]

MessageTypes = (
    RegisterMessage | LoginMessage | RefreshIdMessage | TextMessage |
    KeyExchangeMessage | TypingMessage | FileMetaMessage | FileChunkMessage |
    FileAcceptMessage | FileRejectMessage | DisconnectMessage | PingMessage
)

def validate_message(data: dict[str, Any]) -> tuple[Optional[MessageTypes], Optional[str]]:
    """Valida un mensaje y devuelve (mensaje_validado, error)"""
    try:
        msg_type = data.get("type")
        if not msg_type:
            return None, "Missing message type"
        
        # Mapa de tipos a clases de validación
        type_map = {
            "register": RegisterMessage,
            "login": LoginMessage,
            "refresh_id": RefreshIdMessage,
            "text": TextMessage,
            "key_exchange": KeyExchangeMessage,
            "typing": TypingMessage,
            "file_meta": FileMetaMessage,
            "file_chunk": FileChunkMessage,
            "file_accept": FileAcceptMessage,
            "file_reject": FileRejectMessage,
            "disconnect": DisconnectMessage,
            "ping": PingMessage,
        }
        
        validator = type_map.get(msg_type)
        if not validator:
            return None, f"Unknown message type: {msg_type}"
        
        validated = validator(**data)
        return validated, None
        
    except pydantic.ValidationError as e:
        # Extraer el primer error legible
        errors = e.errors()
        if errors:
            error = errors[0]
            field = "->".join(str(loc) for loc in error["loc"])
            msg = error["msg"]
            return None, f"Validation error in {field}: {msg}"
        return None, "Validation error"
    except Exception as e:
        return None, f"Unexpected error: {str(e)}"

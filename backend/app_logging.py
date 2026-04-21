import structlog
import logging
import sys
from datetime import datetime

# Configurar logging estructurado
def setup_logging(level: str = "INFO"):
    """Configura logging estructurado con formato JSON"""
    
    # Procesadores de structlog
    processors = [
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer()  # Salida JSON
    ]
    
    structlog.configure(
        processors=processors,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    
    # Configurar logging estándar de Python
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, level.upper()),
    )
    
    return structlog.get_logger()

# Métricas en memoria (para monitoreo básico)
class Metrics:
    def __init__(self):
        self.messages_processed = 0
        self.messages_failed = 0
        self.connections_active = 0
        self.connections_total = 0
        self.file_transfers = 0
        self.rate_limits_hit = 0
        self.start_time = datetime.utcnow()
    
    def increment(self, metric: str):
        if hasattr(self, metric):
            setattr(self, metric, getattr(self, metric) + 1)
    
    def get_stats(self) -> dict:
        """Devuelve estadísticas actuales"""
        uptime = (datetime.utcnow() - self.start_time).total_seconds()
        return {
            "uptime_seconds": uptime,
            "messages_processed": self.messages_processed,
            "messages_failed": self.messages_failed,
            "connections_active": self.connections_active,
            "connections_total": self.connections_total,
            "file_transfers": self.file_transfers,
            "rate_limits_hit": self.rate_limits_hit,
            "timestamp": datetime.utcnow().isoformat(),
        }

# Instancia global de métricas
metrics = Metrics()

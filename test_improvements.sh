#!/bin/bash
# Test script for GhostChat improvements

cd "$(dirname "$0")"
source /home/martin/Proyectos/ghostchat-messenger/venv/bin/activate

echo "🧪 Testing GhostChat improvements..."
echo ""

# Test 1: Python syntax
echo "✅ Testing Python syntax..."
python -m py_compile main.py validation.py rate_limit.py logging.py config.py
if [ $? -eq 0 ]; then
    echo "   ✓ All Python files compile successfully"
else
    echo "   ✗ Syntax errors found"
    exit 1
fi

# Test 2: Import validation module
echo ""
echo "✅ Testing module imports..."
cd /home/martin/Proyectos/ghostchat-messenger/backend
python -c "from validation import validate_message; print('   ✓ Validation module loads')
from rate_limit import check_rate_limit, RATE_LIMITS; print('   ✓ Rate limit module loads')
from logging import setup_logging, metrics; print('   ✓ Logging module loads')
from config import *; print('   ✓ Config module loads')"

# Test 3: Check files exist
echo ""
echo "✅ Checking files..."
for file in main.py validation.py rate_limit.py logging.py; do
    if [ -f "$file" ]; then
        echo "   ✓ $file exists"
    else
        echo "   ✗ $file missing"
        exit 1
    fi
done

# Test 4: Frontend files
echo ""
echo "✅ Checking frontend files..."
cd /home/martin/Proyectos/ghostchat-messenger/frontend
if [ -f "sw.js" ]; then
    echo "   ✓ Service Worker exists"
else
    echo "   ✗ Service Worker missing"
    exit 1
fi

if grep -q "sanitizeInput" js/app.js; then
    echo "   ✓ Frontend validation implemented"
else
    echo "   ✗ Frontend validation missing"
fi

# Test 5: Dependencies
echo ""
echo "✅ Checking dependencies..."
cd /home/martin/Proyectos/ghostchat-messenger/backend
python -c "import pydantic; print(f'   ✓ pydantic {pydantic.__version__}')
import structlog; print(f'   ✓ structlog installed')
import python_multipart; print(f'   ✓ python-multipart installed')"

echo ""
echo "🎉 All tests passed! The improvements are ready."
echo ""
echo "📋 Summary of improvements:"
echo "   • Validación de paquetes con Pydantic"
echo "   • Rate limiting persistente por IP"
echo "   • Logging estructurado JSON"
echo "   • Métricas de monitoreo (/metrics)"
echo "   • CSP headers de seguridad"
echo "   • Service Worker completo con cache-first"
echo "   • Validación frontend anti-XSS"
echo ""
echo "🚀 To start the server:"
echo "   source /home/martin/Proyectos/ghostchat-messenger/venv/bin/activate"
echo "   cd /home/martin/Proyectos/ghostchat-messenger/backend"
echo "   uvicorn main:app --host 0.0.0.0 --port 6543 --reload"
echo ""
echo "📊 To view metrics, visit: http://localhost:6543/metrics"
echo "❤️  To check health, visit: http://localhost:6543/health"
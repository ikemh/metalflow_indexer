@echo off
REM ============================================================
REM  DXF Indexer — Instalação no Windows
REM  Execute este script como Administrador
REM ============================================================

echo.
echo === DXF Indexer - Setup Windows ===
echo.

REM Verificar Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERRO: Node.js nao encontrado. Instale em https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo Node.js: %%i

REM Verificar Python
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERRO: Python nao encontrado. Instale em https://www.python.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('python --version') do echo Python: %%i

REM Instalar dependencias Node
echo.
echo Instalando dependencias Node.js...
call npm install --production
if %ERRORLEVEL% neq 0 (
    echo ERRO: falha ao instalar dependencias Node
    pause
    exit /b 1
)

REM Instalar dependencias Python
echo.
echo Instalando dependencias Python...
pip install -r requirements.txt
if %ERRORLEVEL% neq 0 (
    echo ERRO: falha ao instalar dependencias Python
    pause
    exit /b 1
)

REM Verificar config.json
if not exist config.json (
    echo.
    echo AVISO: config.json nao encontrado.
    echo Copie config.example.json para config.json e configure:
    echo   - erpApiUrl: URL do backend na VPS
    echo   - apiKey: mesma chave do INDEXER_API_KEY no backend
    echo   - roots: caminhos das pastas de clientes
    echo.
)

REM Registrar no Task Scheduler
echo.
echo Registrando tarefa no Agendador de Tarefas do Windows...
set "INDEXER_DIR=%~dp0"
set "INDEXER_DIR=%INDEXER_DIR:~0,-1%"

schtasks /create /tn "DXF-Indexer" /tr "cmd /c cd /d \"%INDEXER_DIR%\" && node server.js >> \"%INDEXER_DIR%\indexer.log\" 2>&1" /sc onstart /ru SYSTEM /rl HIGHEST /f
if %ERRORLEVEL% neq 0 (
    echo AVISO: Falha ao criar tarefa agendada. Crie manualmente.
    echo   Nome: DXF-Indexer
    echo   Acao: node server.js
    echo   Diretorio: %INDEXER_DIR%
    echo   Trigger: Ao iniciar o sistema
) else (
    echo Tarefa "DXF-Indexer" criada com sucesso.
    echo Ela iniciara automaticamente ao ligar o computador.
)

echo.
echo === Teste manual ===
echo Execute: node server.js
echo GUI disponivel em: http://localhost:4000
echo.
pause

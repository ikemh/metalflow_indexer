@echo off
REM Remove a tarefa agendada do DXF Indexer
echo Removendo tarefa DXF-Indexer do Agendador de Tarefas...
schtasks /delete /tn "DXF-Indexer" /f
echo Tarefa removida.
pause

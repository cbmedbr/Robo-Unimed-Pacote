# disparar-pendentes.ps1
#
# Dispara os 43 jobs de autorizacao que estao parados em "pendente".
# Preparado em 03/09/2026. Os 10 duplicados ja foram cancelados no banco.
#
# RODE ESTE SCRIPT NA MAQUINA DO ROBO, com o iniciar.bat aberto.
# O servidor so aceita chamadas de localhost, entao nao funciona de outro PC.
#
# Uso:
#   1. Abra o iniciar.bat e espere "Servidor escutando em http://localhost:9876"
#   2. Abra o PowerShell nesta pasta
#   3. Rode:  .\disparar-pendentes.ps1
#
# O script pede confirmacao antes de cada lote. Entre um lote e outro, espere
# a janela do robo mostrar "[fila] Todos os N jobs concluidos" — o servidor
# recusa um lote novo enquanto ainda ha job rodando (limite de 10).

$ErrorActionPreference = "Stop"
$url = "http://localhost:9876/executar"

$lotes = @(
  ,@("708c709d-b7a7-4b4d-92bb-59e23c86546a","de539181-3ecc-4682-9d97-258df6f4a3b4","c8dc8661-20aa-402a-b87f-318a5561a35e","c6827ce6-965d-40ce-939d-855dbb823804","32c53163-1457-4181-b4a1-d3d26b395a7b","64120529-aa43-45a2-850c-bfefbfdc3a60","67956cb4-7c37-4e2b-bd39-af800c3b0b18","a880c98b-be47-446a-aeb4-e09b9273ace1","10f7d26b-b535-4e4b-a7ac-d8e1a1f65bc9","37a6321f-fbb5-4b83-8b7e-721a0386bb66")
  ,@("5da7501f-1498-4d3e-a110-7e6712f88b56","7367d217-d9a8-4cb2-8f1e-2e39e9bf5793","a4ba4cf0-c2cf-47c7-bb0d-b2e9cdb6526a","aef5501c-5c1d-4d7c-98ef-544e500bbe58","21b6a07a-8fd9-488b-a672-f0563a3c5e60","6e4efd78-86ec-4ade-9435-984d54cc0c60","9879443c-6d0a-432f-ae20-06552db66c51","9a37984d-55ba-44cd-8639-a346260556c7","ae19374e-733c-4dfc-9a7d-88dc4f01238c","e6acb699-5e74-44cd-9628-87ab9338eb50")
  ,@("06ec60ac-d961-4acc-a486-c340b84ee6ac","0b9021c9-8abf-4dde-814d-7cd90c040201","17a7c6f4-d142-4eed-a992-b1656fff9c8c","1d3a1d8a-2faa-43ac-aeab-82d377e25158","2496364e-a58c-46a9-8549-338d351c8bb6","34e236b3-7534-4221-8480-37ab54ae1472","5e496bef-b686-4c4f-aca3-d76e63cc7e10","765acbda-871b-4502-90e9-626ab74acf30","b1b8ec24-9ab6-4097-994b-e61f5bf56804","f078e90b-6db8-4411-a3b2-f7f867177c05")
  ,@("f304ae52-27de-4fb3-8477-eff7e2eb0b29","022ca7d2-3c0e-4d2e-8259-4a485e851a40","4c9d49a5-0952-4e14-aed7-a9e9e8611be5","7200e229-fb3a-4325-bc1b-dbb294cb5b61","80b2337e-d547-4532-87dd-80206770781f","8b5814e7-11a4-47d0-a689-fd81c8617d4e","a80df182-9d71-4208-b9a9-ac60926eed6b","d2373df2-fc09-459b-8d3b-b1b055db9fe7","edc5e6b1-9d45-4801-a2b5-45da51c66118","f49935be-7e6b-4e06-a538-014dfd75097f")
  ,@("fff37b1f-ff58-41a0-aa90-a4b0e413500e","d2aaf6c0-dfa1-458f-8120-62a15392a1a5","d007e7b1-df0b-49d2-82b7-05c05da00805")
)

# Confere se o servidor esta de pe antes de qualquer coisa
try {
  $h = Invoke-RestMethod "http://localhost:9876/health" -TimeoutSec 5
  Write-Host "Servidor respondendo." -ForegroundColor Green
} catch {
  Write-Host "ERRO: o servidor nao esta respondendo em localhost:9876." -ForegroundColor Red
  Write-Host "Abra o iniciar.bat, espere subir, e rode este script de novo."
  exit 1
}

Write-Host ""
Write-Host "$($lotes.Count) lotes, 43 jobs no total." -ForegroundColor Cyan
Write-Host "Cada job gera UMA GUIA DE VERDADE na Unimed. Confira antes de confirmar."
Write-Host ""

for ($i = 0; $i -lt $lotes.Count; $i++) {
  $lote = $lotes[$i]
  $n = $i + 1

  Write-Host "----------------------------------------------------"
  Write-Host "Lote $n de $($lotes.Count) — $($lote.Count) jobs" -ForegroundColor Yellow
  $r = Read-Host "Digite S para disparar (qualquer outra coisa encerra)"
  if ($r -ne "S" -and $r -ne "s") {
    Write-Host "Encerrado. Os lotes restantes continuam pendentes." -ForegroundColor DarkGray
    break
  }

  $body = @{ jobIds = $lote } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod $url -Method Post -ContentType "application/json" -Body $body
    Write-Host "  aceitos: $($resp.aceitos)  recusados: $($resp.recusados)" -ForegroundColor Green
    if ($resp.detalhes_recusados) { Write-Host "  $($resp.detalhes_recusados)" -ForegroundColor DarkYellow }
  } catch {
    Write-Host "  ERRO no disparo: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Se falou de limite (429), espere o lote anterior terminar." -ForegroundColor DarkYellow
    break
  }

  Write-Host ""
  Write-Host "  Acompanhe a janela do robo. Espere aparecer" -ForegroundColor Cyan
  Write-Host "  '[fila] Todos os $($lote.Count) jobs concluidos' antes do proximo lote." -ForegroundColor Cyan
  Write-Host ""
}

Write-Host "----------------------------------------------------"
Write-Host "Fim. Confira no CRM quais guias foram geradas." -ForegroundColor Green

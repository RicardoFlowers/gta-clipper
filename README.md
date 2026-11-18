# GTA Clipper

A cada 10 minutos, pega os clipes de **GTA VI** que estão bombando na Twitch, converte pra vertical 1080x1920 (fundo desfocado + crédito do streamer) e manda pro seu **Telegram** com a legenda pronta pra TikTok, Reels e Shorts. Roda de graça no GitHub Actions, com o PC desligado.

## Como escolhe os clipes

- Só lives em português e inglês (`LANGUAGES`), com pelo menos 50 views
- Prioriza o que está subindo rápido (views por hora), com empurrão pros clipes em PT. Busca as últimas 6h e, separado, a última hora, pra clipe novo não sumir no meio dos milhares do pico
- Quando várias pessoas clipam o mesmo momento, manda só o melhor
- No máximo 1 clipe por streamer por rodada e 3 por rodada
- Nunca repete um clipe já enviado

## Campanhas pagas (`campaigns.json`)

Cada campanha diz **quais streamers clipar** e **como o post tem que sair**. O bot busca os clipes desses canais desde o início da campanha (`since`) e converte. Cada clipe chega no Telegram com:

- 💰 nome da campanha e **onde postar** (ex.: conta em inglês)
- a legenda copiável já com o nome do streamer, as hashtags obrigatórias e o aviso de publicidade (`#ad` / `#publi`)
- o aviso `#ad` escrito no topo do vídeo nos 3 primeiros segundos e o nome do streamer embaixo
- links pra **enviar o post** (tem campanha que só aceita até 30 min depois de postar) e pras regras

Campos principais: `enabled`, `source` (`twitch` ou `kick`), `channels` (logins/canais), `since`/`until`, `gameOnly` (só clipes de GTA 6), `lang` (`en`/`pt`), `maxPerHour` (limite de clipes por hora no Telegram), `minViews`, `maxDuration`, `mention`, `hashtags`, `disclosure`, `overlay`, `postWhere`, `submitUrl`, `rulesUrl`. O bloco `general` controla o modo geral (GTA 6 de qualquer streamer); streamers de campanha não saem no geral.

Kick: não tem API oficial de clipes, então o bot usa o mesmo endpoint do site (e o yt-dlp se ele for bloqueado). Se a Kick mudar algo, a campanha falha sozinha e chega um aviso no Telegram; as outras continuam.

Pra ligar/desligar uma campanha, edite `campaigns.json` direto no GitHub e mude `enabled`.

## Configuração

Em **Settings → Secrets and variables → Actions**:

| Secret | De onde vem |
|---|---|
| `TWITCH_CLIENT_SECRET` | dev.twitch.tv/console/apps → app `gta-clipper-flores` → Gerenciar → Novo segredo. O Client ID (público) já está no workflow; pra usar outro app, crie também o secret `TWITCH_CLIENT_ID` |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot`. Depois mande `/start` pro seu bot |

Ajustes opcionais ficam na aba **Variables** (mesmo lugar): `LANGUAGES` (`pt`, `pt,en`, `all`), `MIN_VIEWS`, `CLIPS_PER_RUN`, `MAX_PER_STREAMER`, `LOOKBACK_HOURS`, `BOOST_LANG`, `HASHTAGS`, `GAME_NAME`.

Recomendado: crie também o **secret** `TELEGRAM_CHAT_ID` com o id do seu chat (secret, não variável: variáveis aparecem em texto puro no log público). Sem ele, o id descoberto pelo `/start` fica só no cache do GitHub; se o cache se perder, o bot só volta a mandar depois de um novo `/start`.

## Usando

- Os vídeos chegam no Telegram. Toque no bloco da legenda pra copiar, salve o vídeo e poste.
- Rodar agora: aba **Actions → GTA Clipper → Run workflow** (pula os testes, vai direto aos clipes).
- Se nenhum clipe de uma rodada sair, ou a Twitch der erro, chega um aviso no Telegram (no máximo 1 a cada 3h por problema).
- Pausar: aba **Actions → GTA Clipper → ⋯ → Disable workflow**.
- Se o Telegram falhar, os vídeos da rodada ficam por 2 dias como *artifact* na página da execução.

## Rodar no PC (alternativa)

Precisa de Node 20.12+, ffmpeg e yt-dlp:

```
winget install Gyan.FFmpeg
winget install yt-dlp.yt-dlp
```

```
copy .env.example .env    # e preencha
npm test
npm start                 # fica rodando; npm run once roda uma vez
```

## Avisos

- Mantenha o crédito do streamer. Repostar sem permissão pode dar denúncia/strike; prefira quem libera clippers.
- O GitHub Actions é feito pra projetos de software; um job agendado assim é tolerado, mas se o GitHub reclamar, rode no PC.

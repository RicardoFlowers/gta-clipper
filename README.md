# GTA Clipper

A cada 10 minutos, pega os clipes de **GTA VI** que estão bombando na Twitch, converte pra vertical 1080x1920 (fundo desfocado + crédito do streamer) e manda pro seu **Telegram** com a legenda pronta pra TikTok, Reels e Shorts. Roda de graça no GitHub Actions, com o PC desligado.

## Como escolhe os clipes

- Só lives em português e inglês (`LANGUAGES`), com pelo menos 50 views
- Prioriza o que está subindo rápido (views por hora), com empurrão pros clipes em PT
- Quando várias pessoas clipam o mesmo momento, manda só o melhor
- No máximo 1 clipe por streamer por rodada e 3 por rodada
- Nunca repete um clipe já enviado

## Configuração

Em **Settings → Secrets and variables → Actions**:

| Secret | De onde vem |
|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | dev.twitch.tv/console/apps → Register (redirect `http://localhost`, categoria *Application Integration*, *Confidential*) |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot`. Depois mande `/start` pro seu bot |

Ajustes opcionais ficam na aba **Variables** (mesmo lugar): `LANGUAGES` (`pt`, `pt,en`, `all`), `MIN_VIEWS`, `CLIPS_PER_RUN`, `MAX_PER_STREAMER`, `LOOKBACK_HOURS`, `BOOST_LANG`, `HASHTAGS`, `GAME_NAME`.

## Usando

- Os vídeos chegam no Telegram. Toque no bloco da legenda pra copiar, salve o vídeo e poste.
- Rodar agora: aba **Actions → GTA Clipper → Run workflow**.
- Pausar: aba **Actions → GTA Clipper → ⋯ → Disable workflow**.
- Se o Telegram falhar, os vídeos da rodada ficam por 2 dias como *artifact* na página da execução.

## Rodar no PC (alternativa)

Precisa de Node 20.12+, ffmpeg e yt-dlp (`winget install Gyan.FFmpeg yt-dlp.yt-dlp`).

```
copy .env.example .env    # e preencha
npm test
npm start                 # fica rodando; npm run once roda uma vez
```

## Avisos

- Mantenha o crédito do streamer. Repostar sem permissão pode dar denúncia/strike; prefira quem libera clippers.
- O GitHub Actions é feito pra projetos de software; um job agendado assim é tolerado, mas se o GitHub reclamar, rode no PC.

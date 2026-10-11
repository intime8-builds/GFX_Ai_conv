# GFX Ai Conv Simple Preview

Локальный Windows-конвертер с двумя режимами: **Для AI** и **В Nuke**.
Ветка разработки: `codex/simple-ai-converter`.

Скачать [установщик и portable ZIP, 0.3.0-alpha.1](https://github.com/intime8-builds/GFX_Ai_conv/releases/tag/simple-v0.3.0-alpha.1).
Это отдельный preview, не замена Conform. Установщик пока без цифровой подписи.

- EXR, MOV, MP4: подготовка H.264 MP4 Rec.709 SDR или выбранного кадра PNG16 sRGB.
- Возврат в Nuke без лишнего сжатия, с относительным `.nk` и явным цветом ACES 1.2.
- Полная длительность и исходный размер по умолчанию, очередь, превью и проценты.
- Самостоятельные установщик и portable ZIP, русский интерфейс и отдельный канал обновлений.

Подробное руководство и сборка: [README_SIMPLE.md](README_SIMPLE.md).
Статус проверок: [IMPLEMENTATION_SIMPLE.md](IMPLEMENTATION_SIMPLE.md).

Старая ветка `feature/ai-conform` не изменена. Её описание сохранено отдельно:
[README_CONFORM.md](README_CONFORM.md). Track, undistort, denoise и Topview
не входят в Simple Preview. Совместимость с отдельными AI-сервисами пока не заявляется.

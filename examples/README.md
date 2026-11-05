# Examples

Remakes produced by running the full Remake loop on the test recordings in `../fixtures/videos/`.
The agent worked from the video only. It had no access to `../fixtures/apps/`.

| Example | From | Stack | Rounds | Final score |
|---|---|---|---|---|
| [`web-dashboard/`](web-dashboard) | `fixtures/videos/web-app.mp4` (desktop, 3 screens) | React + Vite + Tailwind | 3 | 0.89 (3/3 pass) |
| [`phone-habits/`](phone-habits) | `fixtures/videos/phone-app.mp4` (phone, 3 screens) | Expo (React Native) | 4 | 0.90 (3/3 pass) |

Each folder has the app source and the `remake-steps.json` that `record_build` replayed.

Try one:

```bash
cd examples/web-dashboard && npm install && npm run build
npx remake-agents record ./ --serve dist --steps remake-steps.json --out /tmp/web-check
```

```bash
cd examples/phone-habits && npm install
npx expo export -p web
npx remake-agents record ./ --serve dist --steps remake-steps.json --viewport phone --out /tmp/phone-check
```

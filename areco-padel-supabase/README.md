# Areco Padel (Supabase)

Reemplazo del sistema Apps Script + Google Sheets.

- `frontend/` — sitio estático (panel admin en `frontend/admin/`). Se despliega en Vercel con *Root Directory* = `frontend`.
- `supabase/functions/api/` — Edge Function que reemplaza a Apps Script (mismo contrato `{fn, args}` → `{ok, result}`).
- `supabase/migrations/` — esquema, funciones transaccionales y cron de recordatorios.

Proyecto Supabase: `jeibzbijbmfcqeyxidgp` (Areco Padel v2, sa-east-1).

## Secrets de la Edge Function (Supabase → Edge Functions → Secrets)
`MP_ACCESS_TOKEN`, `FRONTEND_URL`, `RESEND_API_KEY`, `EMAIL_FROM` (opcional), `ONESIGNAL_APP_ID`, `ONESIGNAL_API_KEY`, `ONESIGNAL_ADMIN_SUBSCRIPTION_ID`.

## Notas
- No subir datos de clientes ni claves al repo. La anon/service key nunca va en el front: el front solo conoce la URL de la función.
- Falta agregar el `index.html` del sitio de clientes en `frontend/` con la misma URL de la función.

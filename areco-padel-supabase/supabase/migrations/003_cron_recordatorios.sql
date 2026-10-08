create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('areco-recordatorios-horario', '0 * * * *', $$select net.http_post(
  url := 'https://jeibzbijbmfcqeyxidgp.supabase.co/functions/v1/api',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body := '{"fn":"procesarRecordatoriosPendientes","args":[]}'::jsonb);$$);

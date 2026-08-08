-- Normaliza fones gravados sem DDI (Yampi manda nacional 10-11 dígitos; a Meta
-- manda com 55). Sem isso o webhook não acha a row e o envio live iria errado.
-- 10-11 dígitos = formato nacional (DDD+número) — SEMPRE ganha o 55 na frente
-- (um 11 dígitos começando com 55 é DDD 55, Santa Maria/RS — também nacional).
UPDATE wa_upsell
SET customer_phone = '55' || customer_phone
WHERE customer_phone ~ '^[0-9]{10,11}$';

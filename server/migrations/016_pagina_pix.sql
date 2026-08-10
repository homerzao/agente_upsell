-- Página do PIX (Jorge, 10/08): link público server-rendered com o código
-- copia-e-cola, timer e botão de copiar — pra quem não consegue copiar a
-- mensagem no WhatsApp (Maria, Beatriz e Vanessa no mesmo dia).
-- Token opaco de 128 bits (base64url, 22 chars), gerado no aceite e ESTÁVEL
-- pela vida da row: reenvio/novo PIX não troca o link — a página sempre
-- mostra o estado atual (vivo/pago/expirado).
ALTER TABLE wa_upsell ADD COLUMN IF NOT EXISTS pix_pagina_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS wa_upsell_pix_pagina_token_uk
  ON wa_upsell (pix_pagina_token) WHERE pix_pagina_token IS NOT NULL;

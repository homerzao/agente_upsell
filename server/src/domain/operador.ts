// Regras do operador respondendo pelo painel (puras — cobertas por teste).
import { mesmoFone } from '../lib/util.js';

export type MotivoBloqueio = 'bot_conduzindo' | 'modo_test_fone_diferente' | 'sem_chatwoot';

export type DecisaoEnvio = { pode: true } | { pode: false; motivo: MotivoBloqueio; mensagem: string };

// Operador só fala depois de assumir (senão bot e humano respondem junto) e,
// em modo test, só com o número de teste (gotcha 24: nada vai pra cliente real).
export function decidirEnvioOperador(args: {
  statusConversa: string;
  modo: 'test' | 'live';
  fone: string | null | undefined;
  foneTeste: string;
  temChatwoot: boolean;
}): DecisaoEnvio {
  if (args.statusConversa !== 'humano') {
    return {
      pode: false,
      motivo: 'bot_conduzindo',
      mensagem: 'assuma a conversa antes de enviar (o bot ainda está respondendo)',
    };
  }
  if (args.modo === 'test' && !mesmoFone(args.fone, args.foneTeste)) {
    return {
      pode: false,
      motivo: 'modo_test_fone_diferente',
      mensagem: 'modo test: só é possível responder o número de teste',
    };
  }
  if (!args.temChatwoot) {
    return { pode: false, motivo: 'sem_chatwoot', mensagem: 'conversa sem Chatwoot configurado' };
  }
  return { pode: true };
}

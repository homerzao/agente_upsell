import { useEffect, useState } from 'react';
import { get, post, put } from '../api';

export default function Disparo() {
  const [dados, setDados] = useState<any>(null);
  const [cpfs, setCpfs] = useState('');
  const [rate, setRate] = useState(0);
  const [amostra, setAmostra] = useState('');
  const [modo, setModo] = useState<'test' | 'live'>('test');
  const [orderManual, setOrderManual] = useState('');
  const [msg, setMsg] = useState('');

  const carregar = () =>
    get('/api/disparo').then((r) => {
      setDados(r);
      setCpfs((r.config.cpf_filtro ?? []).join(', '));
      setRate(r.config.rate_por_hora ?? 0);
      setAmostra(r.config.amostra_restante === null ? '' : String(r.config.amostra_restante));
      setModo(r.config.modo);
    });

  useEffect(() => {
    carregar().catch((e) => setMsg(e.message));
  }, []);

  const salvar = async (extra: Record<string, unknown> = {}) => {
    setMsg('');
    try {
      await put('/api/disparo', {
        modo,
        cpf_filtro: cpfs.split(',').map((s) => s.trim()).filter(Boolean),
        rate_por_hora: Number(rate) || 0,
        amostra_restante: amostra === '' ? null : Number(amostra),
        ...extra,
      });
      setMsg('✅ Configuração salva');
      await carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  // Ações pontuais mandam PUT PARCIAL (só o campo alterado): mandar a config
  // inteira arrastaria valores stale (ex.: re-armar amostra_restante já consumida)
  const togglePausa = async () => {
    const pausar = !dados.config.pausado;
    if (pausar && !window.confirm('PAUSAR todos os disparos (kill switch global)?')) return;
    if (!pausar && !window.confirm('RETOMAR os disparos? A fila represada será enviada respeitando o rate.')) return;
    setMsg('');
    try {
      await put('/api/disparo', { pausado: pausar });
      await carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  const mudarModo = async (novo: 'test' | 'live') => {
    if (novo === 'live' && !window.confirm(
      'Ir pra LIVE?\n\nAs mensagens passam a ir pro CLIENTE REAL de cada pedido.\nEm test, tudo vai pro número de teste do Jorge.',
    )) return;
    setMsg('');
    try {
      await put('/api/disparo', { modo: novo });
      await carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  const dispararManual = async () => {
    if (!orderManual) return;
    if (!window.confirm(`Disparar o funil pro pedido ${orderManual}? (busca na Yampi e envia o template)`)) return;
    setMsg('');
    try {
      await post('/api/disparo/manual', { order_id: Number(orderManual) });
      setMsg(`✅ Pedido ${orderManual} na fila de disparo`);
      setOrderManual('');
      await carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  if (!dados) return <div>Carregando…</div>;

  return (
    <div>
      <h1>Disparo controlado</h1>
      <p className="sub">Piloto, amostragem, rate limit e kill switch — nada dispara sem passar por aqui.</p>

      <div className="painel kill">
        <label className="interruptor">
          <input type="checkbox" checked={!dados.config.pausado} onChange={togglePausa} />
          <span />
        </label>
        <div>
          <b>{dados.config.pausado ? '⏸️ PAUSADO (kill switch ativo)' : '▶️ Disparos ativos'}</b>
          <div className="sub" style={{ margin: 0 }}>
            Fila represada: {dados.fila} · enviados nesta hora: {dados.usados_na_hora}
            {dados.config.rate_por_hora ? ` / ${dados.config.rate_por_hora}` : ' (sem limite)'}
          </div>
        </div>
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Modo</h2>
        <div className="linha">
          <button className={modo === 'test' ? 'primario' : ''} onClick={() => mudarModo('test')}>
            🧪 test — tudo pro número do Jorge
          </button>
          <button className={modo === 'live' ? 'primario' : ''} onClick={() => mudarModo('live')}>
            🔴 live — mensagens pro cliente real
          </button>
        </div>
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Piloto e limites</h2>
        <div className="campo">
          <label>Filtro de CPFs (separados por vírgula; VAZIO = aberto pra todos os pedidos)</label>
          <input value={cpfs} onChange={(e) => setCpfs(e.target.value)} style={{ width: '100%' }}
            placeholder="04686204194" />
        </div>
        <div className="linha">
          <div className="campo">
            <label>Rate limit (disparos/hora; 0 = sem limite)</label>
            <input type="number" min={0} value={rate} onChange={(e) => setRate(Number(e.target.value))} style={{ width: 160 }} />
          </div>
          <div className="campo">
            <label>Amostragem: disparar pros próximos N pedidos (vazio = sem amostra)</label>
            <input type="number" min={0} value={amostra} onChange={(e) => setAmostra(e.target.value)} style={{ width: 160 }}
              placeholder="ex.: 5" />
          </div>
          <div className="campo">
            <button className="primario" onClick={() => salvar()}>Salvar</button>
          </div>
        </div>
        {dados.config.amostra_restante !== null && (
          <div className="aviso">
            Amostragem ativa: restam <b>{dados.config.amostra_restante}</b> disparos. Ao zerar, novos pedidos entram
            como fora_do_fluxo até você renovar a amostra ou limpar o campo.
          </div>
        )}
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Disparo manual</h2>
        <div className="linha">
          <div className="campo">
            <label>order_id da Yampi (o ID interno, não o número longo)</label>
            <input value={orderManual} onChange={(e) => setOrderManual(e.target.value.replace(/\D/g, ''))}
              style={{ width: 200 }} placeholder="169610420" />
          </div>
          <div className="campo">
            <button className="primario" disabled={!orderManual} onClick={dispararManual}>Disparar</button>
          </div>
        </div>
      </div>

      {msg && <div className="aviso">{msg}</div>}
    </div>
  );
}

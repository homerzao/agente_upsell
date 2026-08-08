import { useCallback, useEffect, useState } from 'react';
import { fmtDataHora, get, post } from '../api';

function Diff({ antes, depois }: { antes: any; depois: any }) {
  const fmt = (o: any) =>
    Object.entries(o ?? {})
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v, null, 2) : v}`)
      .join('\n');
  return (
    <div className="diff">
      <div className="antes">
        <h4>ANTES (Yampi hoje)</h4>
        <pre>{fmt(antes)}</pre>
      </div>
      <div className="depois">
        <h4>DEPOIS (o que o cliente pediu)</h4>
        <pre>{fmt(depois)}</pre>
      </div>
    </div>
  );
}

export default function Aprovacoes() {
  const [aba, setAba] = useState('aguardando_aprovacao');
  const [correcoes, setCorrecoes] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [processando, setProcessando] = useState<number | null>(null);

  const carregar = useCallback(() => {
    get(`/api/aprovacoes?status=${aba}`).then((r) => setCorrecoes(r.correcoes)).catch((e) => setMsg(e.message));
  }, [aba]);

  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 20_000);
    return () => clearInterval(t);
  }, [carregar]);

  const aprovar = async (c: any) => {
    if (!window.confirm(
      `APROVAR a correção do pedido ${c.order_id}?\n\nO sistema vai aplicar na Yampi, conferir lendo de volta e avisar o cliente.`,
    )) return;
    setProcessando(c.id);
    setMsg('');
    try {
      await post(`/api/aprovacoes/${c.id}/aprovar`);
      setMsg(`✅ Correção ${c.id} aplicada na Yampi e verificada`);
      carregar();
    } catch (e: any) {
      setMsg(`Erro na aplicação: ${e.message}`);
      carregar();
    } finally {
      setProcessando(null);
    }
  };

  const rejeitar = async (c: any) => {
    const motivo = window.prompt(`Motivo da rejeição da correção do pedido ${c.order_id}:`);
    if (motivo === null) return;
    setProcessando(c.id);
    try {
      await post(`/api/aprovacoes/${c.id}/rejeitar`, { motivo });
      setMsg(`Correção ${c.id} rejeitada — cliente avisado e encaminhado ao time`);
      carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    } finally {
      setProcessando(null);
    }
  };

  return (
    <div>
      <h1>Aprovações de correção</h1>
      <p className="sub">Nenhuma alteração vai pra Yampi sem passar por aqui.</p>
      <div className="linha" style={{ marginBottom: 12 }}>
        {[
          ['aguardando_aprovacao', 'Aguardando'],
          ['aplicada', 'Aplicadas'],
          ['rejeitada', 'Rejeitadas'],
          ['erro_aplicacao', 'Com erro'],
          ['todas', 'Todas'],
        ].map(([k, v]) => (
          <button key={k} className={aba === k ? 'primario' : ''} onClick={() => setAba(k)}>{v}</button>
        ))}
      </div>
      {msg && <div className="aviso">{msg}</div>}
      {correcoes.map((c) => (
        <div className="painel" key={c.id}>
          <div className="linha" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <b>Pedido {c.order_id}</b> <span className="mono">#{c.order_number}</span> — {c.customer_name}
              <div className="sub" style={{ margin: 0 }}>
                pedida em {fmtDataHora(c.criado_em)}
                {c.aprovador ? ` · decidida por ${c.aprovador} em ${fmtDataHora(c.decidido_em)}` : ''}
                {c.motivo ? ` · ${c.motivo}` : ''}
              </div>
            </div>
            <span className={`etiqueta ${c.status === 'aplicada' ? 'pago' : c.status.includes('erro') ? 'erro' : ''}`}>
              {c.status}
            </span>
          </div>
          <div style={{ margin: '12px 0' }}>
            <Diff antes={c.campos_antes} depois={c.campos_depois} />
          </div>
          {c.status === 'aguardando_aprovacao' && (
            <div className="linha">
              <button className="ok" disabled={processando === c.id} onClick={() => aprovar(c)}>
                {processando === c.id ? 'Aplicando…' : '✓ Aprovar e aplicar na Yampi'}
              </button>
              <button className="perigo" disabled={processando === c.id} onClick={() => rejeitar(c)}>
                ✕ Rejeitar
              </button>
            </div>
          )}
        </div>
      ))}
      {!correcoes.length && <div className="painel sub">Nenhuma correção nesta aba.</div>}
    </div>
  );
}

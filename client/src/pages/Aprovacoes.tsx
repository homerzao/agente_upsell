import { useCallback, useEffect, useState } from 'react';
import { fmtDataHora, get, post } from '../api';

const NOME_CAMPO: Record<string, string> = {
  nome: 'Nome', email: 'E-mail', street: 'Rua', number: 'Número', complement: 'Complemento',
  neighborhood: 'Bairro', city: 'Cidade', state: 'UF', zip_code: 'CEP', receiver: 'Recebe',
};

// Achata {nome, email, endereco:{...}} numa lista de campos comparáveis.
function achatar(o: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as object)) {
        if (v2 !== null && v2 !== undefined) out[k2] = String(v2);
      }
    } else out[k] = String(v);
  }
  return out;
}

// Uma linha por campo, mudança em destaque — sem JSON, sem caça ao que mudou.
function Diff({ antes, depois }: { antes: any; depois: any }) {
  const a = achatar(antes);
  const d = achatar(depois);
  const campos = [...new Set([...Object.keys(a), ...Object.keys(d)])];
  const mudados = campos.filter((c) => (a[c] ?? '') !== (d[c] ?? '') && d[c] !== undefined);
  const iguais = campos.filter((c) => !mudados.includes(c));
  return (
    <table className="diff-tabela">
      <thead>
        <tr><th>Campo</th><th>Está assim na Yampi</th><th></th><th>Cliente pediu</th></tr>
      </thead>
      <tbody>
        {mudados.map((c) => (
          <tr key={c} className="mudou">
            <td className="campo">{NOME_CAMPO[c] ?? c}</td>
            <td className="antes">{a[c] ?? <i>(vazio)</i>}</td>
            <td className="seta">→</td>
            <td className="depois"><b>{d[c]}</b></td>
          </tr>
        ))}
        {iguais.filter((c) => a[c] !== undefined).map((c) => (
          <tr key={c} className="igual">
            <td className="campo">{NOME_CAMPO[c] ?? c}</td>
            <td colSpan={3} className="mantem">{a[c]} <span className="sub">(não muda)</span></td>
          </tr>
        ))}
        {!mudados.length && (
          <tr><td colSpan={4} className="sub">Nada muda — correção vazia ou já aplicada.</td></tr>
        )}
      </tbody>
    </table>
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
      `APROVAR a correção do pedido ${c.order_id}?\n\nO sistema aplica na Yampi e confere lendo de volta.\nNENHUMA mensagem é enviada ao cliente.`,
    )) return;
    // avisar o cliente é opt-in, nunca automático
    const avisar = window.confirm('Quer TAMBÉM avisar o cliente no WhatsApp que a correção foi feita?\n\nOK = avisa · Cancelar = aplica em silêncio');
    setProcessando(c.id);
    setMsg('');
    try {
      await post(`/api/aprovacoes/${c.id}/aprovar`, { avisar_cliente: avisar });
      setMsg(`✅ Correção ${c.id} aplicada na Yampi e verificada${avisar ? ' — cliente avisado' : ' (sem avisar o cliente)'}`);
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
    const avisar = window.confirm('Avisar o CLIENTE que a correção não foi aplicada?\n\nOK = avisa · Cancelar = em silêncio');
    setProcessando(c.id);
    try {
      await post(`/api/aprovacoes/${c.id}/rejeitar`, { motivo, avisar_cliente: avisar });
      setMsg(`Correção ${c.id} rejeitada${avisar ? ' — cliente avisado' : ' (sem avisar o cliente)'}`);
      carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    } finally {
      setProcessando(null);
    }
  };

  // Ignorar: tira da fila sem tocar na Yampi e sem falar com o cliente.
  // Serve pra correção duplicada, teste, ou caso já resolvido na mão.
  const ignorar = async (c: any) => {
    if (!window.confirm(`Ignorar a correção do pedido ${c.order_id}?\n\nNada muda na Yampi e NENHUMA mensagem é enviada.`)) return;
    setProcessando(c.id);
    try {
      await post(`/api/aprovacoes/${c.id}/rejeitar`, { motivo: 'ignorada no painel', avisar_cliente: false });
      setMsg(`Correção ${c.id} ignorada — nada alterado, nada enviado`);
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
              <button
                disabled={processando === c.id}
                onClick={() => ignorar(c)}
                title="Tira da fila sem mexer na Yampi e sem enviar nada ao cliente"
              >
                🚫 Ignorar
              </button>
            </div>
          )}
        </div>
      ))}
      {!correcoes.length && <div className="painel sub">Nenhuma correção nesta aba.</div>}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { fmtBRL, fmtDataHora, get, put } from '../api';

const COPIES_ROTULOS: Record<string, string> = {
  flow_saudacao: 'Flow — saudação',
  flow_linha_pedido: 'Flow — linha do pedido',
  flow_linha_nome: 'Flow — linha do nome',
  flow_linha_email: 'Flow — linha do e-mail',
  flow_linha_endereco: 'Flow — linha do endereço',
  flow_titulo_ticket: 'Flow — título do Ticket Dourado',
  flow_corpo_corrigir: 'Flow — corpo do corrigir',
  flow_saudacao_ok: 'Flow — confirmação ok',
  flow_oferta_urgencia: 'Flow v8 — linha de urgência do ticket',
  flow_oferta_intro: 'Flow v8 — introdução dos itens',
  flow_oferta_bullets: 'Flow v8 — itens da oferta (bullets)',
  flow_oferta_extras: 'Flow v8 — extras (frete etc.)',
  flow_oferta_preco_linha: 'Flow v8 — linha do preço',
  flow_oferta_prazo_linha: 'Flow v8 — linha do prazo do PIX',
  flow_ticket_img_arquivo: 'Flow v8 — arquivo da arte do cupom (em /marca; ex.: ticket-art-fps70.jpg)',
  flow_confirma_titulo: 'Flow v8 — título da tela de conquista',
  flow_confirma_resumo: 'Flow v8 — resumo da conquista (usa {{preco_de}} {{economia}} {{desconto_pct}})',
  msg_aceite: 'Sessão — mensagem do aceite (antes do PIX)',
  msg_pix_instabilidade: 'Sessão — instabilidade do PIX',
  msg_corrigir: 'Sessão — pré-resposta do corrigir',
  msg_pago: 'Sessão — pagamento confirmado 🎉',
  anotacao_yampi: 'Anotação no pedido da Yampi',
  pix_item_descricao: 'Descrição do item no PIX (Pagar.me)',
  msg_correcao_aplicada: 'Sessão — correção aplicada',
  msg_correcao_rejeitada: 'Sessão — correção rejeitada',
  header_url: 'URL da imagem do header (preferida — media id expira ~30d)',
  header_media_id: 'Media ID do header (fallback)',
  template_nome: 'Nome do template aprovado (vazio = env)',
};

export default function Oferta() {
  const [ofertas, setOfertas] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [historico, setHistorico] = useState<any[]>([]);
  const [msg, setMsg] = useState('');

  const carregar = () =>
    get('/api/ofertas').then((r) => {
      setOfertas(r.ofertas);
      if (r.ofertas.length && !sel) selecionar(r.ofertas.find((o: any) => o.ativo) ?? r.ofertas[0]);
    });

  const selecionar = (o: any) => {
    setSel({
      ...o,
      preco: Number(o.preco),
      preco_de: o.preco_de === null ? null : Number(o.preco_de),
      ticket_min: o.ticket_min === null || o.ticket_min === undefined ? null : Number(o.ticket_min),
      ticket_max: o.ticket_max === null || o.ticket_max === undefined ? null : Number(o.ticket_max),
      prioridade: Number(o.prioridade ?? 0),
    });
    get(`/api/ofertas/${o.id}/historico`).then((r) => setHistorico(r.historico)).catch(() => {});
  };

  useEffect(() => {
    carregar().catch((e) => setMsg(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const salvar = async () => {
    setMsg('');
    try {
      await put(`/api/ofertas/${sel.id}`, {
        nome: sel.nome,
        sku_yampi: sel.sku_yampi,
        preco: Number(sel.preco),
        preco_de: sel.preco_de === null || sel.preco_de === '' ? null : Number(sel.preco_de),
        ativo: sel.ativo,
        copies: sel.copies,
        ticket_min: sel.ticket_min === null || sel.ticket_min === '' ? null : Number(sel.ticket_min),
        ticket_max: sel.ticket_max === null || sel.ticket_max === '' ? null : Number(sel.ticket_max),
        prioridade: Number(sel.prioridade ?? 0),
      });
      setMsg('✅ Oferta salva (versão anterior guardada no histórico)');
      await carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  if (!sel) return <div>Carregando…</div>;

  const chavesCopies = Array.from(new Set([...Object.keys(COPIES_ROTULOS), ...Object.keys(sel.copies ?? {})]));

  return (
    <div>
      <h1>Gestão da oferta</h1>
      <p className="sub">Produto, preços e copies do funil — tudo versionado.</p>

      {ofertas.length > 1 && (
        <div className="linha" style={{ marginBottom: 12 }}>
          {ofertas.map((o) => (
            <button key={o.id} className={sel.id === o.id ? 'primario' : ''} onClick={() => selecionar(o)}>
              {o.nome} {o.ativo ? '· ATIVA' : ''}
            </button>
          ))}
        </div>
      )}

      <div className="painel">
        <div className="linha">
          <div className="campo" style={{ flex: 2, minWidth: 240 }}>
            <label>Produto</label>
            <input value={sel.nome} onChange={(e) => setSel({ ...sel, nome: e.target.value })} style={{ width: '100%' }} />
          </div>
          <div className="campo">
            <label>SKU Yampi</label>
            <input value={sel.sku_yampi} onChange={(e) => setSel({ ...sel, sku_yampi: e.target.value })} style={{ width: 140 }} />
          </div>
          <div className="campo">
            <label>Preço (R$)</label>
            <input type="number" step="0.01" value={sel.preco} onChange={(e) => setSel({ ...sel, preco: e.target.value })} style={{ width: 120 }} />
          </div>
          <div className="campo">
            <label>DE (R$)</label>
            <input type="number" step="0.01" value={sel.preco_de ?? ''} onChange={(e) => setSel({ ...sel, preco_de: e.target.value })} style={{ width: 120 }} />
          </div>
          <div className="campo">
            <label>Ativa</label>
            <label className="interruptor">
              <input type="checkbox" checked={sel.ativo} onChange={(e) => setSel({ ...sel, ativo: e.target.checked })} />
              <span />
            </label>
          </div>
        </div>
        {/* multi-oferta por faixa de ticket: valor de PRODUTO do pedido (subtotal − desconto, sem frete) */}
        <div className="linha" style={{ marginTop: 10 }}>
          <div className="campo">
            <label>Ticket de (R$)</label>
            <input
              type="number" step="0.01" placeholder="sem mínimo"
              value={sel.ticket_min ?? ''}
              onChange={(e) => setSel({ ...sel, ticket_min: e.target.value })}
              style={{ width: 130 }}
            />
          </div>
          <div className="campo">
            <label>até (R$, exclusivo)</label>
            <input
              type="number" step="0.01" placeholder="sem teto"
              value={sel.ticket_max ?? ''}
              onChange={(e) => setSel({ ...sel, ticket_max: e.target.value })}
              style={{ width: 130 }}
            />
          </div>
          <div className="campo">
            <label>Prioridade</label>
            <input
              type="number" step="1"
              value={sel.prioridade ?? 0}
              onChange={(e) => setSel({ ...sel, prioridade: e.target.value })}
              style={{ width: 90 }}
            />
          </div>
          <div className="sub" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
            O pedido entra na oferta cuja faixa contém o valor de produto (subtotal − desconto, sem frete).
            Faixa vazia = pega tudo. Se duas faixas casam, a de MAIOR prioridade vence.
          </div>
        </div>
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Copies</h2>
        <p className="sub">
          Placeholders: {'{{nome}} {{nome_completo}} {{numero}} {{email}} {{endereco}} {{produto}} {{preco}} {{minutos}} {{sku}} {{qtd}} {{valor}} {{charge_id}} {{resumo}}'}
        </p>
        {chavesCopies.map((k) => (
          <div className="campo" key={k}>
            <label>{COPIES_ROTULOS[k] ?? k}</label>
            <textarea
              rows={String(sel.copies?.[k] ?? '').length > 80 ? 4 : 1}
              value={sel.copies?.[k] ?? ''}
              onChange={(e) => setSel({ ...sel, copies: { ...sel.copies, [k]: e.target.value } })}
              style={{ width: '100%' }}
            />
          </div>
        ))}
        <button className="primario" onClick={salvar}>Salvar oferta</button>
        {msg && <div className="aviso">{msg}</div>}
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Histórico de versões</h2>
        <table>
          <thead>
            <tr><th>Quando</th><th>Quem</th><th>Snapshot</th></tr>
          </thead>
          <tbody>
            {historico.map((h) => (
              <tr key={h.id}>
                <td>{fmtDataHora(h.criado_em)}</td>
                <td>{h.usuario ?? '—'}</td>
                <td className="mono">
                  {h.snapshot?.nome} · {fmtBRL(h.snapshot?.preco)} · SKU {h.snapshot?.sku_yampi} ·{' '}
                  {h.snapshot?.ativo ? 'ativa' : 'inativa'}
                </td>
              </tr>
            ))}
            {!historico.length && <tr><td colSpan={3} className="sub">Sem alterações registradas ainda.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

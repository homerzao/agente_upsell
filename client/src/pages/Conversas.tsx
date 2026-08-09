import { useCallback, useEffect, useRef, useState } from 'react';
import { ETAPA_LABEL, fmtDataHora, get, post } from '../api';

const POR_PAGINA = 50;
const INTERVALO_MS = 10000;

// Avatar por iniciais, com cor derivada do nome (mesma pessoa, mesma cor sempre).
const iniciais = (nome: string | null) =>
  (nome ?? '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase() || '?';

const corDoNome = (nome: string | null) => {
  const s = String(nome ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 62%)`;
};

const soHora = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

function Avatar({ nome, pequeno }: { nome: string | null; pequeno?: boolean }) {
  return (
    <div className={`avatar${pequeno ? ' pequeno' : ''}`} style={{ background: corDoNome(nome) }}>
      {iniciais(nome)}
    </div>
  );
}

export default function Conversas() {
  const [dados, setDados] = useState<{ conversas: any[]; total: number; chatwoot_link_base: string | null }>({
    conversas: [],
    total: 0,
    chatwoot_link_base: null,
  });
  const [sel, setSel] = useState<any>(null);
  const [mensagens, setMensagens] = useState<any[]>([]);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const [status, setStatus] = useState('');
  const [pagina, setPagina] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);
  const [autoOn, setAutoOn] = useState(true);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [verArquivadas, setVerArquivadas] = useState(false);
  // Padrão: só conversas com mensagem trocada (as sem interação poluem a lista)
  const [verTodas, setVerTodas] = useState(false);

  const selId = sel?.id ?? null;
  const fimDoChat = useRef<HTMLDivElement | null>(null);
  const qtdMensagens = useRef(0);

  const carregarLista = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('limit', String(POR_PAGINA));
    params.set('offset', String(pagina * POR_PAGINA));
    if (buscaAtiva) params.set('q', buscaAtiva);
    if (status) params.set('status', status);
    if (verArquivadas) params.set('arquivadas', '1');
    if (verTodas) params.set('todas', '1');
    setDados(await get(`/api/conversas?${params}`));
  }, [pagina, buscaAtiva, status, verArquivadas, verTodas]);

  // Detalhe + mensagens da conversa aberta: sem isso o cabeçalho (etapa, custo,
  // contador) congelava no estado de quando ela foi clicada.
  const carregarConversa = useCallback(async (id: number) => {
    const [detalhe, msgs] = await Promise.all([
      get(`/api/conversas/${id}`),
      get(`/api/conversas/${id}/mensagens`),
    ]);
    setSel(detalhe.conversa);
    setMensagens(msgs.mensagens);
  }, []);

  // O botão atualiza TUDO — antes só rebuscava as mensagens, então a lista
  // continuava com contador e prévia velhos e parecia que nada acontecia.
  const atualizar = useCallback(
    async (silencioso = false) => {
      if (!silencioso) setBuscando(true);
      try {
        await Promise.all([carregarLista(), selId ? carregarConversa(selId) : Promise.resolve()]);
        setErro('');
        setAtualizadoEm(new Date());
      } catch (e: any) {
        setErro(e.message);
      } finally {
        if (!silencioso) setBuscando(false);
      }
    },
    [carregarLista, carregarConversa, selId],
  );

  useEffect(() => {
    carregarLista()
      .then(() => setAtualizadoEm(new Date()))
      .catch((e) => setErro(e.message));
  }, [carregarLista]);

  useEffect(() => {
    if (!selId) return;
    carregarConversa(selId)
      .then(() => setAtualizadoEm(new Date()))
      .catch((e) => setErro(e.message));
  }, [selId, carregarConversa]);

  useEffect(() => {
    if (!autoOn) return;
    const t = setInterval(() => atualizar(true), INTERVALO_MS);
    return () => clearInterval(t);
  }, [autoOn, atualizar]);

  // Rola pro fim quando chega mensagem nova (não a cada re-render)
  useEffect(() => {
    if (mensagens.length !== qtdMensagens.current) {
      qtdMensagens.current = mensagens.length;
      fimDoChat.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [mensagens]);

  // Troca de conversa: mostra o cabeçalho na hora (dado da lista) e o efeito
  // de [selId] busca o detalhe canônico + mensagens.
  const abrir = (c: any) => {
    if (c.id === selId) return;
    setSel(c);
    setMensagens([]);
    qtdMensagens.current = 0;
  };

  const acao = async (caminho: string, confirmacao: string) => {
    if (!sel || !window.confirm(confirmacao)) return;
    setAviso('');
    try {
      await post(`/api/conversas/${sel.id}/${caminho}`);
      await atualizar();
      setAviso(caminho === 'assumir' ? '✅ Conversa assumida — o bot parou de responder' : '✅ Conversa devolvida ao bot');
    } catch (e: any) {
      setErro(e.message);
    }
  };

  // Arquivar tira da lista padrão (dá pra reler no filtro "Arquivadas")
  const arquivar = async (arquivarAgora: boolean) => {
    if (!sel) return;
    try {
      await post(`/api/conversas/${sel.id}/arquivar`, { desarquivar: !arquivarAgora });
      setAviso(arquivarAgora ? '🗄 Conversa arquivada' : '📂 Conversa desarquivada');
      if (arquivarAgora && !verArquivadas) {
        setSel(null);
        setMensagens([]);
      }
      await atualizar(true);
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const enviar = async () => {
    const msg = texto.trim();
    if (!sel || !msg) return;
    setEnviando(true);
    setErro('');
    try {
      await post(`/api/conversas/${sel.id}/mensagem`, { texto: msg });
      setTexto('');
      await atualizar(true);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setEnviando(false);
    }
  };

  const totalPaginas = Math.max(1, Math.ceil(dados.total / POR_PAGINA));
  const ehHumano = sel?.status === 'humano';

  return (
    <div>
      <h1>Conversas do agente</h1>
      <p className="sub">
        Acompanhamento ao vivo. O bot responde sozinho enquanto a conversa estiver com ele — assuma para
        falar você mesmo.
      </p>
      {erro && <div className="erro-msg">{erro}</div>}
      {aviso && <div className="aviso">{aviso}</div>}

      <div className="chat-layout">
        {/* ----- coluna da esquerda: lista ----- */}
        <div className="chat-col">
          <div className="chat-col-topo">
            <input
              placeholder="Buscar nome, fone ou pedido…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPagina(0);
                  setBuscaAtiva(busca.trim());
                }
              }}
              style={{ flex: 1, minWidth: 140 }}
            />
            <select
              value={status}
              onChange={(e) => {
                setPagina(0);
                setStatus(e.target.value);
              }}
            >
              <option value="">Todas</option>
              <option value="bot">🤖 bot</option>
              <option value="humano">👤 humano</option>
            </select>
            <button
              onClick={() => {
                setPagina(0);
                setSel(null);
                setMensagens([]);
                setVerArquivadas(!verArquivadas);
              }}
              className={verArquivadas ? 'primario' : ''}
              title="Alterna entre conversas ativas e arquivadas"
            >
              {verArquivadas ? '↩ Ativas' : '🗄 Arquivadas'}
            </button>
            <button
              onClick={() => {
                setPagina(0);
                setVerTodas(!verTodas);
              }}
              title={
                verTodas
                  ? 'Mostrando todas, inclusive quem nunca respondeu'
                  : 'Mostrando só conversas com mensagem trocada'
              }
            >
              {verTodas ? '💬 Só com interação' : '👁 Ver todas'}
            </button>
            {buscaAtiva && (
              <button
                onClick={() => {
                  setBusca('');
                  setBuscaAtiva('');
                  setPagina(0);
                }}
              >
                Limpar
              </button>
            )}
            <span className="sub" style={{ margin: 0, width: '100%' }}>
              {dados.total} conversa{dados.total === 1 ? '' : 's'}
            </span>
          </div>

          <div className="chat-col-rolagem">
            {dados.conversas.map((c) => (
              <button key={c.id} className={`conv-item${c.id === selId ? ' sel' : ''}`} onClick={() => abrir(c)}>
                <Avatar nome={c.customer_name} />
                <div className="corpo">
                  <div className="titulo">
                    <span className="nome">{c.customer_name ?? `Pedido ${c.order_id ?? '—'}`}</span>
                    <span className="hora">{soHora(c.ultima_em ?? c.atualizado_em)}</span>
                  </div>
                  <div className="previa">
                    {c.ultima_mensagem
                      ? `${c.ultima_direcao === 'out' ? '↩ ' : ''}${c.ultima_mensagem}`
                      : 'Sem mensagens ainda'}
                  </div>
                  <div className="rodape">
                    <span className={`etiqueta ${c.status === 'humano' ? 'erro' : 'pago'}`}>
                      {c.status === 'humano' ? '👤 humano' : '🤖 bot'}
                    </span>
                    {c.etapa && <span className="etiqueta">{ETAPA_LABEL[c.etapa] ?? c.etapa}</span>}
                    <span className="sub" style={{ margin: 0 }}>{c.mensagens} msg</span>
                  </div>
                </div>
              </button>
            ))}
            {!dados.conversas.length && (
              <div className="sub" style={{ padding: 16 }}>Nenhuma conversa encontrada.</div>
            )}
          </div>

          {totalPaginas > 1 && (
            <div className="linha" style={{ gap: 8, padding: 10, justifyContent: 'center', borderTop: '1px solid var(--border)' }}>
              <button disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>←</button>
              <span className="sub" style={{ margin: 0 }}>{pagina + 1} / {totalPaginas}</span>
              <button disabled={pagina >= totalPaginas - 1} onClick={() => setPagina(pagina + 1)}>→</button>
            </div>
          )}
        </div>

        {/* ----- coluna da direita: thread ----- */}
        <div className="chat-col">
          {!sel && <div className="chat-vazio">Selecione uma conversa à esquerda.</div>}
          {sel && (
            <>
              <div className="chat-cabecalho">
                <Avatar nome={sel.customer_name} />
                <div>
                  <b>{sel.customer_name ?? 'Cliente'}</b>
                  <div className="sub" style={{ margin: 0 }}>
                    Pedido {sel.order_id ?? '—'} · {ETAPA_LABEL[sel.etapa] ?? sel.etapa ?? '—'}
                    {Number(sel.custo) > 0 && ` · IA ${Number(sel.custo).toFixed(4)}`}
                  </div>
                </div>
                <div className="acoes">
                  <span className="sub" style={{ margin: 0 }}>
                    {buscando ? (
                      <span className="giro">↻</span>
                    ) : atualizadoEm ? (
                      `atualizado ${atualizadoEm.toLocaleTimeString('pt-BR')}`
                    ) : (
                      ''
                    )}
                  </span>
                  <button onClick={() => atualizar()} disabled={buscando}>
                    {buscando ? 'Atualizando…' : '↻ Atualizar'}
                  </button>
                  <button onClick={() => setAutoOn(!autoOn)} title={`auto a cada ${INTERVALO_MS / 1000}s`}>
                    {autoOn ? '⏸' : '▶'}
                  </button>
                  <button
                    onClick={() => arquivar(!sel.arquivada_em)}
                    title={sel.arquivada_em ? 'Tirar do arquivo' : 'Arquivar (some da lista; veja em Arquivadas)'}
                  >
                    {sel.arquivada_em ? '📂 Desarquivar' : '🗄 Arquivar'}
                  </button>
                  {ehHumano ? (
                    <button onClick={() => acao('devolver', 'Devolver a conversa ao bot? Ele volta a responder sozinho.')}>
                      🤖 Devolver ao bot
                    </button>
                  ) : (
                    <button
                      className="primario"
                      onClick={() => acao('assumir', 'Assumir a conversa? O bot para de responder e você passa a falar com o cliente.')}
                    >
                      👤 Assumir
                    </button>
                  )}
                  {dados.chatwoot_link_base && sel.chatwoot_conversation_id && (
                    <a
                      href={`${dados.chatwoot_link_base}/${sel.chatwoot_conversation_id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Chatwoot ↗
                    </a>
                  )}
                </div>
              </div>

              <div className="chat-corpo">
                {mensagens.map((m) => (
                  <div
                    key={m.id}
                    className={`msg ${m.direcao}${m.contexto?.origem === 'operador' ? ' operador' : ''}`}
                  >
                    {m.texto}
                    <div className="meta">
                      {fmtDataHora(m.criado_em)}
                      {m.contexto?.origem === 'operador' ? ` · ${m.contexto.usuario ?? 'operador'}` : ''}
                      {m.tokens ? ` · ${m.tokens} tokens` : ''}
                      {m.prompt_hash ? ` · prompt ${String(m.prompt_hash).slice(0, 8)}` : ''}
                    </div>
                  </div>
                ))}
                {!mensagens.length && <div className="sub">Sem mensagens registradas.</div>}
                <div ref={fimDoChat} />
              </div>

              {ehHumano ? (
                <div className="composer">
                  <textarea
                    value={texto}
                    onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        enviar();
                      }
                    }}
                    placeholder="Escreva pro cliente… (Enter envia, Shift+Enter quebra linha)"
                    rows={1}
                  />
                  <button className="primario" onClick={enviar} disabled={enviando || !texto.trim()}>
                    {enviando ? 'Enviando…' : 'Enviar'}
                  </button>
                </div>
              ) : (
                <div className="composer-travado">
                  🤖 O bot está conduzindo esta conversa. Clique em <b>Assumir</b> para responder você mesmo.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

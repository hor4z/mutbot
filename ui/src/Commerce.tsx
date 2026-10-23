/**
 * Vista "Comercio" del panel del personaje: ver catálogos de NPC y tiendas personales leídos, filtrarlos y
 * compararlos con tu equipo y bolsa, el plan de "qué vender y dónde", "mi tienda" y el trade directo.
 *
 * Leer es seguro. Todo lo que mueve zen o ítems (comprar, vender, abrir tienda, trade) pasa por un diálogo
 * con el resumen (ítem, cantidad y TOTAL) y recién al confirmar sale la orden `commerce` con su `confirm`.
 * El bot además exige estar en pausa. Nada de acá se dispara solo.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Handshake, RefreshCw, Search, Store, TriangleAlert, X } from "lucide-react";
import type { CommerceDraft, PanelCommand, PanelState, ShopItemView, ShopsView, ShopView } from "../../panel-protocol";
import { commerceToken } from "../../commerce-packets";
import { compareToWorn, opSummary, type OpSummary } from "../../commerce-plan";
import { scoreOf } from "../../item-score";
import { Action, fmt } from "./components";
import "./commerce.css";

type Send = (c: PanelCommand) => number | null;
type Props = { state: PanelState | null; send: Send; online: boolean; demo?: boolean };

const zen = (n: number | null | undefined) => (n == null ? "—" : `${n.toLocaleString("es-AR")} zen`);
const tags = (i: ShopItemView) =>
  [i.skill && "skill", i.luck && "luck", i.option ? `+${i.option * 4}` : "", i.excCount ? `exc×${i.excCount}` : i.excellent ? "exc" : "", i.ancient && "anc", i.opt380 && "380", i.harmony && `arm ${i.harmony.option}/${i.harmony.level}`].filter(Boolean).join(" ");
const label = (i: ShopItemView) => `${i.name}${i.level ? ` +${i.level}` : ""}`;

type Pending = { draft: CommerceDraft; summary: OpSummary; extra?: ReactNode };

/** Diálogo de confirmación: resumen con ítem, cantidad y TOTAL; el botón queda apagado si el personaje no está en pausa. */
function Confirm({ pending, paused, onCancel, onConfirm, onPause }: { pending: Pending | null; paused: boolean; onCancel: () => void; onConfirm: () => void; onPause: () => void }) {
  const s = pending?.summary;
  return (
    <Dialog.Root open={!!pending} onOpenChange={(v) => !v && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="modal confirm commerce-confirm">
          <header className="modal-head">
            <div>
              <Dialog.Title>{s?.title}</Dialog.Title>
              <Dialog.Description className="confirm-warn">
                <TriangleAlert size={14} />
                {s?.danger ? "Esto mueve ítems o zen reales y no se deshace solo." : "Revisá el resumen antes de confirmar."}
              </Dialog.Description>
            </div>
            <Dialog.Close className="button quiet icon" aria-label="Cerrar"><X size={16} /></Dialog.Close>
          </header>
          <div className="modal-body">
            <ul className="commerce-lines">{s?.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <p className="commerce-total">{s?.total}</p>
            {pending?.extra}
            {!paused && (
              <p className="commerce-pause">
                El personaje tiene que estar en pausa para comerciar (así no camina ni pelea en el medio).{" "}
                <button className="link-btn" onClick={onPause}>Pausar ahora</button>
              </p>
            )}
          </div>
          <footer className="modal-foot">
            <span className="grow" />
            <button className="button quiet" autoFocus onClick={onCancel}>Cancelar</button>
            <button className={`button ${s?.danger ? "danger" : "primary"}`} disabled={!paused} onClick={onConfirm}>Confirmar</button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="muted commerce-empty">{children}</p>;

export function CommerceView({ state, send, online, demo }: Props) {
  const sh: ShopsView | null | undefined = state?.shops;
  const [sub, setSub] = useState<"ver" | "plan" | "tienda" | "trade">("ver");
  const [pending, setPending] = useState<Pending | null>(null);
  const paused = state?.mode === "paused";
  const live = online && !!state;
  const bagBySlot = useMemo(() => new Map((sh?.bag ?? []).map((b) => [b.slot, b])), [sh?.bag]);
  const refresh = () => send({ cmd: "shops" });
  const ask = (draft: CommerceDraft, extra?: ReactNode, shopItem?: (slot: number) => ShopItemView | undefined, price?: (slot: number) => number | null) =>
    setPending({
      draft,
      extra,
      summary: opSummary(draft, {
        name: (slot, from) => { const i = from === "bag" ? bagBySlot.get(slot) : shopItem?.(slot); return i ? label(i) : `casilla ${slot}`; },
        zen: state?.char.zen ?? null,
        price,
      }),
    });
  const confirm = () => {
    if (!pending) return;
    const d = pending.draft;
    const op = d.kind === "shop-close" || d.kind === "trade-cancel" ? d : { ...d, confirm: commerceToken(d) };
    send({ cmd: "commerce", op } as PanelCommand);
    setPending(null);
  };

  return (
    <div className="commerce">
      <div className="commerce-top">
        <div className="seg" role="tablist" aria-label="Comercio">
          {([["ver", "Catálogos y tiendas"], ["plan", "Bolsa y plan"], ["tienda", "Mi tienda"], ["trade", "Trade"]] as const).map(([k, t]) => (
            <button key={k} role="tab" aria-selected={sub === k} className={sub === k ? "on" : ""} onClick={() => setSub(k)}>{t}</button>
          ))}
        </div>
        <span className="grow" />
        <Action className="small" disabled={!live} onClick={refresh} title="Actualiza qué hay a la vista (no compra ni vende)"><RefreshCw size={13} /> Actualizar</Action>
      </div>
      <p className="commerce-note">
        <Store size={13} /> Leer es seguro. Comprar, vender, abrir tu tienda y tradear piden confirmación con el total y que el personaje esté en pausa; nunca pasan solos.
        {demo && " Modo demo: ninguna orden sale a ningún bot."}
      </p>
      {!sh && <Empty>Todavía no se leyó nada. “Actualizar” muestra los vendedores y jugadores a la vista; “Leer catálogo” / “Leer tienda” piden la lista.</Empty>}
      {sub === "ver" && <SeeTab sh={sh} state={state} live={live} send={send} ask={ask} />}
      {sub === "plan" && <PlanTab sh={sh} ask={ask} live={live} />}
      {sub === "tienda" && <MyShopTab sh={sh} ask={ask} send={send} live={live} />}
      {sub === "trade" && <TradeTab sh={sh} state={state} ask={ask} live={live} />}
      <Confirm pending={pending} paused={paused} onCancel={() => setPending(null)} onConfirm={confirm} onPause={() => send({ cmd: "pause" })} />
    </div>
  );
}

type Ask = (d: CommerceDraft, extra?: ReactNode, shopItem?: (slot: number) => ShopItemView | undefined, price?: (slot: number) => number | null) => void;

// --- Catálogos y tiendas leídos ------------------------------------------------------------------
function SeeTab({ sh, state, live, send, ask }: { sh: ShopsView | null | undefined; state: PanelState | null; live: boolean; send: Send; ask: Ask }) {
  const [pick, setPick] = useState<string>("");
  const [q, setQ] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minScore, setMinScore] = useState("");
  const [onlyBetter, setOnlyBetter] = useState(false);
  const [onlyExc, setOnlyExc] = useState(false);
  const [sort, setSort] = useState<"slot" | "price" | "score" | "value">("slot");
  const shops = sh?.shops ?? [];
  const cur: ShopView | undefined = shops.find((s) => `${s.kind}:${s.id}` === pick) ?? shops[0];
  const equipped = sh?.equipped ?? [];

  const rows = useMemo(() => {
    if (!cur) return [];
    const mp = maxPrice ? Number(maxPrice.replace(/\D/g, "")) : null;
    const ms = minScore ? Number(minScore) : null;
    let r = cur.items.map((i) => ({ i, score: i.group >= 6 && i.group <= 11 ? scoreOf(i) : 0, cmp: compareToWorn(i, equipped) }));
    if (q.trim()) r = r.filter((x) => x.i.name.toLowerCase().includes(q.trim().toLowerCase()));
    if (mp != null && !Number.isNaN(mp)) r = r.filter((x) => x.i.price == null || x.i.price <= mp);
    if (ms != null && !Number.isNaN(ms)) r = r.filter((x) => x.score >= ms);
    if (onlyBetter) r = r.filter((x) => x.cmp.slotName != null && x.cmp.delta > 0);
    if (onlyExc) r = r.filter((x) => x.i.excellent || (x.i.excCount ?? 0) > 0);
    const val = (x: (typeof r)[number]) => (x.i.price ? x.score / x.i.price : -1);
    if (sort === "price") r = [...r].sort((a, b) => (a.i.price ?? Infinity) - (b.i.price ?? Infinity));
    else if (sort === "score") r = [...r].sort((a, b) => b.score - a.score);
    else if (sort === "value") r = [...r].sort((a, b) => val(b) - val(a));
    return r;
  }, [cur, equipped, q, maxPrice, minScore, onlyBetter, onlyExc, sort]);

  return (
    <div className="commerce-grid">
      <aside className="card commerce-side">
        <h3>A la vista</h3>
        <h4>Vendedores</h4>
        {(sh?.vendors ?? []).length === 0 && <Empty>Ningún NPC a la vista.</Empty>}
        <ul className="commerce-list">
          {(sh?.vendors ?? []).map((v) => (
            <li key={v.id}>
              <span>{v.name}<small className="muted"> · {v.dist} casillas</small></span>
              <Action className="small" disabled={!live || v.dist > 6} title={v.dist > 6 ? "Acercate a 6 casillas o menos" : "Habla con el NPC, lee el catálogo y cierra"} onClick={() => send({ cmd: "shops", npc: v.id })}>Leer catálogo</Action>
            </li>
          ))}
        </ul>
        <h4>Jugadores</h4>
        {(sh?.players ?? []).length === 0 && <Empty>Nadie a la vista.</Empty>}
        <ul className="commerce-list">
          {(sh?.players ?? []).map((p) => (
            <li key={p.id}>
              <span>{p.name}{p.shop && <em className="commerce-shop-title"> “{p.shop}”</em>}<small className="muted"> · {p.dist} casillas</small></span>
              <Action className="small" disabled={!live || p.dist > 10} title="Pide la lista de su tienda personal (solo lectura)" onClick={() => send({ cmd: "shops", player: p.id })}>Leer tienda</Action>
            </li>
          ))}
        </ul>
        {(sh?.notes ?? []).length > 0 && (
          <details className="commerce-notes"><summary>{sh!.notes.length} nota(s) para verificar packets</summary><ul>{sh!.notes.map((n, i) => <li key={i}><code>{n}</code></li>)}</ul></details>
        )}
      </aside>
      <section className="card commerce-main">
        {shops.length === 0 ? (
          <Empty>Ningún catálogo ni tienda leídos todavía.</Empty>
        ) : (
          <>
            <div className="chips">
              {shops.map((s) => (
                <button key={`${s.kind}:${s.id}`} className={`chip ${cur === s ? "on" : ""}`} onClick={() => setPick(`${s.kind}:${s.id}`)}>
                  {s.kind === "npc" ? <Store size={12} /> : <Handshake size={12} />} {s.name} <small>({s.items.length})</small>
                </button>
              ))}
            </div>
            {cur && (
              <p className="muted commerce-meta">
                {cur.kind === "npc" ? "Catálogo de NPC" : `Tienda personal${cur.title ? ` “${cur.title}”` : ""}`} · leído {new Date(cur.at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                {!cur.verified && <span className="commerce-unverified"> · layout SIN verificar en vivo</span>}
                {cur.kind === "npc" && " · el NPC no publica precios (los cobra el server)"}
              </p>
            )}
            <div className="commerce-filters">
              <label className="search compact"><Search size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar ítem" aria-label="Buscar ítem" /></label>
              <label className="field-mini">Precio máx<input inputMode="numeric" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="zen" /></label>
              <label className="field-mini">Puntaje mín<input inputMode="numeric" value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="0" /></label>
              <button className={`chip-toggle ${onlyBetter ? "on" : ""}`} onClick={() => setOnlyBetter(!onlyBetter)}>Mejora lo puesto</button>
              <button className={`chip-toggle ${onlyExc ? "on" : ""}`} onClick={() => setOnlyExc(!onlyExc)}>Excelentes</button>
              <label className="field-mini">Orden
                <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                  <option value="slot">Casilla</option><option value="price">Precio</option><option value="score">Puntaje</option><option value="value">Puntaje por zen</option>
                </select>
              </label>
            </div>
            <div className="table-wrap">
              <table className="data commerce-table">
                <thead><tr><th>Ítem</th><th className="num">Puntaje</th><th>Contra lo puesto</th><th className="num">Cristales</th><th className="num">Precio</th><th /></tr></thead>
                <tbody>
                  {rows.map(({ i, score, cmp }) => (
                    <tr key={i.slot}>
                      <td><strong>{label(i)}</strong> <small className="muted">{tags(i)}</small></td>
                      <td className="num">{score ? score.toFixed(0) : "—"}</td>
                      <td>{cmp.slotName == null ? <span className="muted">—</span> : <span className={cmp.delta > 0 ? "good" : cmp.delta < 0 ? "bad" : "muted"} title={`${cmp.slotName}: ${cmp.worn ?? "vacío"} (${cmp.wornScore})`}>{cmp.delta > 0 ? "+" : ""}{cmp.delta} en {cmp.slotName}</span>}</td>
                      <td className="num">{cmp.crystals ?? "—"}</td>
                      <td className="num">{cur!.kind === "npc" ? <span className="muted" title="El NPC no publica el precio">—</span> : i.price === 0 ? <span className="muted">muestra</span> : zen(i.price)}</td>
                      <td className="num">
                        <BuyButton shop={cur!} item={i} live={live} state={state} ask={ask} />
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={6}><Empty>Nada con esos filtros.</Empty></td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function BuyButton({ shop, item, live, state, ask }: { shop: ShopView; item: ShopItemView; live: boolean; state: PanelState | null; ask: Ask }) {
  const [qty, setQty] = useState("1");
  const [cap, setCap] = useState("");
  if (shop.kind === "player") {
    if (!item.price) return null;
    return (
      <Action className="small" disabled={!live} onClick={() => ask({ kind: "shop-buy", player: shop.id, slot: item.slot, price: item.price! }, null, () => item, () => item.price)}>Comprar…</Action>
    );
  }
  const n = Math.max(1, Math.min(20, Number(qty) || 1));
  const maxZen = Math.min(Number(cap.replace(/\D/g, "")) || (item.price ?? 0) * n, state?.char.zen ?? 0);
  return (
    <span className="buy-inline">
      <input aria-label="Cantidad" className="mini" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input aria-label="Tope de zen" className="mini wide" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="tope zen" />
      <Action className="small" disabled={!live || maxZen <= 0} title={maxZen <= 0 ? "Poné un tope de zen: el NPC no publica el precio" : "Comprar a este NPC"} onClick={() => ask({ kind: "buy", npc: shop.id, slot: item.slot, qty: n, maxZen }, null, () => item, () => item.price)}>Comprar…</Action>
    </span>
  );
}

// --- Bolsa y plan --------------------------------------------------------------------------------
function PlanTab({ sh, ask, live }: { sh: ShopsView | null | undefined; ask: Ask; live: boolean }) {
  const plan = sh?.plan;
  const [off, setOff] = useState<Set<number>>(new Set());
  if (!sh || !plan) return <Empty>Sin datos todavía: “Actualizar”.</Empty>;
  const chosen = plan.sell.filter((s) => !off.has(s.slot)).slice(0, 8);
  const toggle = (slot: number) => setOff((o) => { const n = new Set(o); n.has(slot) ? n.delete(slot) : n.add(slot); return n; });
  return (
    <div className="commerce-grid two">
      <section className="card commerce-main">
        <h3>Qué vender y dónde <small className="muted">(propuesta; el bot no ejecuta nada solo)</small></h3>
        <p>{plan.summary}</p>
        {plan.venue ? <p className="muted">Dónde: {plan.venue.name} ({plan.venue.dist} casillas).</p> : <p className="bad">No hay un NPC vendedor a la vista.</p>}
        {plan.sell.length === 0 ? <Empty>No hay nada para vender: todo lo de la bolsa sirve o se guarda.</Empty> : (
          <ul className="commerce-list checks">
            {plan.sell.map((s) => (
              <li key={s.slot}>
                <label><input type="checkbox" checked={!off.has(s.slot)} onChange={() => toggle(s.slot)} /> <strong>{s.name}</strong> <small className="muted">casilla {s.slot} · {s.why}</small></label>
                <span className="num">{s.zen != null ? zen(s.zen) : <span className="muted" title="El server no publica cuánto paga el NPC">zen ?</span>}</span>
              </li>
            ))}
          </ul>
        )}
        <Action className="danger" disabled={!live || !plan.venue || chosen.length === 0} onClick={() => ask({ kind: "sell", npc: plan.venue!.id, items: chosen.map((s) => s.ref) })}>
          Vender {chosen.length} al NPC…
        </Action>
        {plan.sell.length > 8 && <small className="muted"> (hasta 8 por orden)</small>}
        {plan.notes.length > 0 && <ul className="commerce-notes-list">{plan.notes.map((n, i) => <li key={i} className="muted">{n}</li>)}</ul>}
      </section>
      <section className="card commerce-main">
        <h3>Cristalizar <small className="muted">(Alquimista; no es una orden de comercio)</small></h3>
        {plan.crystallize.length === 0 ? <Empty>Nada para cristalizar.</Empty> : <ul className="commerce-list">{plan.crystallize.map((c) => <li key={c.slot}><span><strong>{c.name}</strong> <small className="muted">casilla {c.slot}</small></span><span className="num">{c.crystals} Cristales</span></li>)}</ul>}
        {plan.shop.length > 0 && <><h4>Posibles para la tienda personal</h4><ul className="commerce-list">{plan.shop.map((c) => <li key={c.slot}><span>{c.name}</span><small className="muted">{c.why}</small></li>)}</ul></>}
        <h3>Se guarda <small className="muted">(cajas y Cristales son para el usuario)</small></h3>
        <ul className="commerce-list">{plan.keep.map((k) => <li key={k.slot}><span><strong>{k.name}</strong> <small className="muted">casilla {k.slot}</small></span><small className="muted">{k.why}</small></li>)}</ul>
      </section>
    </div>
  );
}

// --- Mi tienda -----------------------------------------------------------------------------------
function MyShopTab({ sh, ask, send, live }: { sh: ShopsView | null | undefined; ask: Ask; send: Send; live: boolean }) {
  const [title, setTitle] = useState("");
  const [sel, setSel] = useState<Record<number, string>>({});
  const bag = (sh?.bag ?? []).filter((b) => !(b.group === 14 && (b.num === 11 || b.num === 31)) && !b.harmony);
  const picked = bag.filter((b) => sel[b.slot] !== undefined);
  const toggle = (b: ShopItemView) => setSel((s) => { const n = { ...s }; if (b.slot in n) delete n[b.slot]; else n[b.slot] = ""; return n; });
  const price = (b: ShopItemView) => Math.max(0, Math.min(2_000_000_000, Number((sel[b.slot] ?? "").replace(/\D/g, "")) || 0));
  const mine = sh?.mine;
  const draft: CommerceDraft | null = picked.length > 0 && title.trim() ? { kind: "shop-open", title: title.trim().slice(0, 36), items: picked.map((b) => ({ slot: b.slot, group: b.group, num: b.num, level: b.level, price: price(b) })) } : null;
  return (
    <div className="commerce-grid two">
      <section className="card commerce-main">
        <h3>Mi tienda personal</h3>
        {mine?.open ? (
          <>
            <p className="good">Abierta: “{mine.title}”</p>
            <ul className="commerce-list">{mine.items.map((i) => <li key={i.slot}><span>{i.name}</span><span className="num">{i.price === 0 ? "muestra" : zen(i.price)}</span></li>)}</ul>
            <Action disabled={!live} onClick={() => send({ cmd: "commerce", op: { kind: "shop-close" } })}>Cerrar tienda</Action>
          </>
        ) : (
          <>
            <p className="muted">Elegí los ítems de la bolsa y su precio (0 = de muestra, no se vende). Las cajas y los Cristales no se ponen en venta: se guardan. Se abre en la ciudad y se cierra si te teletransportás.</p>
            <label className="field"><span>Cartel (hasta 36 caracteres)</span><input className="field-input" value={title} maxLength={36} onChange={(e) => setTitle(e.target.value)} placeholder="Ej: sets baratos" /></label>
            <Action className="danger" disabled={!live || !draft} onClick={() => draft && ask(draft)}>Abrir mi tienda…</Action>
            {mine && !mine.open && <p className="muted">Última tienda: “{mine.title}” (cerrada).</p>}
          </>
        )}
        <p className="commerce-unverified">Packets de la tienda personal SIN verificar en vivo (docs/comercio.md).</p>
      </section>
      <section className="card commerce-main">
        <h3>Bolsa <small className="muted">(elegí lo que va a la venta)</small></h3>
        <ul className="commerce-list checks">
          {bag.map((b) => (
            <li key={b.slot}>
              <label><input type="checkbox" checked={b.slot in sel} onChange={() => toggle(b)} /> <strong>{label(b)}</strong> <small className="muted">casilla {b.slot} {tags(b)}</small></label>
              {b.slot in sel && <input aria-label={`Precio de ${b.name}`} className="mini wide" inputMode="numeric" value={sel[b.slot]} placeholder="precio zen" onChange={(e) => setSel((s) => ({ ...s, [b.slot]: e.target.value }))} />}
            </li>
          ))}
          {bag.length === 0 && <Empty>Bolsa vacía.</Empty>}
        </ul>
      </section>
    </div>
  );
}

// --- Trade ---------------------------------------------------------------------------------------
function TradeTab({ sh, state, ask, live }: { sh: ShopsView | null | undefined; state: PanelState | null; ask: Ask; live: boolean }) {
  const [who, setWho] = useState<number | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [z, setZ] = useState("");
  const players = sh?.players ?? [];
  const mates = new Map((state?.entities?.players ?? []).map((p) => [p.id, !!p.mate]));
  const trade = sh?.trade;
  const bag = sh?.bag ?? [];
  const chosen = bag.filter((b) => sel.has(b.slot)).slice(0, 16);
  const amount = Math.min(Number(z.replace(/\D/g, "")) || 0, state?.char.zen ?? 0);
  const toggle = (slot: number) => setSel((s) => { const n = new Set(s); n.has(slot) ? n.delete(slot) : n.add(slot); return n; });
  const target = who ?? players.find((p) => mates.get(p.id))?.id ?? players[0]?.id ?? null;
  const open = trade && (trade.state === "open" || trade.state === "requested" || trade.state === "incoming");
  return (
    <div className="commerce-grid two">
      <section className="card commerce-main">
        <h3>Trade directo <small className="muted">(mulas: pasarle Cristales y cajas a otro de tus personajes)</small></h3>
        {trade && (
          <div className={`commerce-trade ${trade.state}`}>
            <p><strong>{trade.with}</strong> · {trade.state === "incoming" ? "te pidió trade" : trade.state === "requested" ? "esperando respuesta" : trade.state === "open" ? "ventana abierta" : trade.state === "done" ? "hecho" : "cancelado"}{trade.note && <span className="muted"> — {trade.note}</span>}</p>
            <div className="commerce-trade-sides">
              <div><h4>Pongo</h4><ul>{trade.mine.map((i) => <li key={i.slot}>{label(i)}</li>)}{trade.mineZen > 0 && <li>{zen(trade.mineZen)}</li>}{trade.mine.length === 0 && trade.mineZen === 0 && <li className="muted">nada</li>}</ul></div>
              <div><h4>Pone {trade.with}</h4><ul>{trade.theirs.map((i) => <li key={i.slot}>{label(i)} <small className="muted">{tags(i)}</small></li>)}{trade.theirsZen > 0 && <li>{zen(trade.theirsZen)}</li>}{trade.theirs.length === 0 && trade.theirsZen === 0 && <li className="muted">nada todavía</li>}</ul></div>
            </div>
            <div className="commerce-trade-actions">
              {trade.state === "incoming" && trade.withId != null && <Action className="danger" disabled={!live} onClick={() => ask({ kind: "trade-accept", player: trade.withId! })}>Aceptar…</Action>}
              {trade.state === "open" && <Action className="danger" disabled={!live} onClick={() => ask({ kind: "trade-ok" }, <p className="muted">Marcá OK solo si revisaste lo que pone {trade.with}.</p>)}>Marcar OK…</Action>}
              {open && <Action disabled={!live} onClick={() => ask({ kind: "trade-cancel" })}>Cancelar trade…</Action>}
            </div>
          </div>
        )}
        <label className="field"><span>Con quién</span>
          <select className="field-input" value={target ?? ""} onChange={(e) => setWho(Number(e.target.value))}>
            {players.length === 0 && <option value="">Nadie a la vista</option>}
            {players.map((p) => <option key={p.id} value={p.id}>{p.name}{mates.get(p.id) ? " (mío)" : ""} · {p.dist} casillas</option>)}
          </select>
        </label>
        <label className="field"><span>Zen a ofrecer (tenés {fmt(state?.char.zen)})</span><input className="field-input" inputMode="numeric" value={z} onChange={(e) => setZ(e.target.value)} placeholder="0" /></label>
        <Action className="danger" disabled={!live || target == null || (chosen.length === 0 && amount === 0) || !!open} onClick={() => target != null && ask({ kind: "trade", player: target, items: chosen.map((b) => ({ slot: b.slot, group: b.group, num: b.num, level: b.level })), zen: amount })}>
          Ofrecer trade…
        </Action>
        <p className="commerce-unverified">Packets de trade SIN verificar en vivo. El otro personaje tiene que aceptar con su propia orden; no acepta solo.</p>
      </section>
      <section className="card commerce-main">
        <h3>Qué ofrezco <small className="muted">(hasta 16 ítems; la ventana es de 8×4)</small></h3>
        <ul className="commerce-list checks">
          {bag.map((b) => (
            <li key={b.slot}><label><input type="checkbox" checked={sel.has(b.slot)} onChange={() => toggle(b.slot)} /> <strong>{label(b)}</strong> <small className="muted">casilla {b.slot} {tags(b)}</small></label></li>
          ))}
          {bag.length === 0 && <Empty>Bolsa vacía.</Empty>}
        </ul>
      </section>
    </div>
  );
}

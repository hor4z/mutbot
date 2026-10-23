import { useEffect, useMemo, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Activity, BookOpen, CircleHelp, Flag, MessageSquare, Shield, Store, Swords, Terminal, WifiOff } from "lucide-react";
import type { PanelCommand } from "../../panel-protocol";
import { Choice, Confirm, Modal } from "./components";
import { computeAlerts, SPOTS } from "./hud-logic";
import { CommerceView } from "./Commerce";
import { Radar } from "./Radar";
import { useBot } from "./useBot";
import { demoMode } from "./demo";
import {
  AlertStrip,
  BagGrid,
  BagSummary,
  Card,
  ChatPanel,
  Console,
  EventsView,
  ExpCard,
  Feed,
  Goldens,
  Header,
  Journal,
  Nearby,
  Paperdoll,
  QuickActions,
  SHORTCUTS,
  SessionTiles,
  Skills,
  Stats,
  type Dialogs,
} from "./panel-parts";

const hunts = [
  { value: "auto", label: "El mapa con más dorados vivos" },
  { value: "0", label: "Lorencia" },
  { value: "3", label: "Noria" },
  { value: "2", label: "Devias" },
  { value: "7", label: "Atlans" },
  { value: "8", label: "Tarkan" },
];
const TABS = [
  { value: "overview", label: "Resumen", Icon: Activity },
  { value: "combat", label: "Combate", Icon: Swords },
  { value: "gear", label: "Equipo y bolsa", short: "Equipo", Icon: Shield },
  { value: "events", label: "Eventos", Icon: Flag },
  { value: "commerce", label: "Comercio", Icon: Store },
  { value: "chat", label: "Chat", Icon: MessageSquare },
  { value: "journal", label: "Diario", Icon: BookOpen },
  { value: "console", label: "Consola", Icon: Terminal },
] as const;

export function Panel() {
  const { state: s, connected, attempt, logs, chats, decisions, feed, samples, result, toast, send, lastAt, levels, still } = useBot();
  const demo = demoMode();
  const [tab, setTab] = useState<string>(() => {
    try {
      return localStorage.getItem("mubot.panel.tab") ?? "overview";
    } catch {
      return "overview";
    }
  });
  const [now, setNow] = useState(Date.now());
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [help, setHelp] = useState(false);
  const [warp, setWarp] = useState("26");
  const [hunt, setHunt] = useState("auto");

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const changeTab = (v: string) => {
    setTab(v);
    try {
      localStorage.setItem("mubot.panel.tab", v);
    } catch {
      /* ignorar */
    }
  };

  const stale = !!s && now - lastAt.current > 5000;
  const online = connected && !stale && !!s;
  const disabled = !online;
  const alerts = useMemo(
    () => computeAlerts(s, { now, stillMs: now - still.current.since, online }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, Math.floor(now / 5000), online],
  );

  const [t0, l0] = levels.current[0] ?? [now, s?.char.level ?? 0];
  const rate = ((s?.char.level ?? 0) - l0) / Math.max(1, (now - t0) / 60000);
  const eta = rate > 0.05 ? Math.max(0, Math.round((400 - (s?.char.level ?? 0)) / rate)) : null;

  const spots = useMemo(
    () => SPOTS.filter((x) => !s || x.level <= s.char.level).map((x) => ({ value: x.value, label: `${x.label} · nv ${x.level}+` })),
    [s?.char.level],
  );
  useEffect(() => {
    if (spots.length && !spots.some((x) => x.value === warp)) setWarp(spots[spots.length - 1]!.value);
  }, [spots, warp]);
  const spotName = spots.find((x) => x.value === warp)?.label.split(" · ")[0] ?? "ese spot";

  // Atajos de teclado (no se activan escribiendo en un campo ni con un diálogo abierto).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector('[role="alertdialog"], [role="dialog"][data-open]')) return;
      const k = e.key;
      if (k === "?") setHelp(true);
      else if (/^[1-7]$/.test(k)) changeTab(TABS[+k - 1]!.value);
      else if (k.toLowerCase() === "p" && online) send({ cmd: s?.mode === "paused" ? "resume" : "pause" });
      else if (k.toLowerCase() === "r" && online) setDialog("farm");
      else if (k.toLowerCase() === "h" && online) setDialog("hunt");
      else if (k.toLowerCase() === "w" && online) setDialog("warp");
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [online, s?.mode, send]);

  const run = (c: PanelCommand) => {
    send(c);
  };
  const offline = !online && (
    <span className="hud-alert off">
      <WifiOff size={14} />
      {demo === "off"
        ? "Modo demo desconectado: así se ve la vista cuando el bot no responde."
        : !connected
          ? attempt > 1
            ? `Sin conexión con el bot. Reintentando (intento ${attempt})…`
            : "Conectando con el bot…"
          : stale
            ? `Sin novedades hace ${Math.max(0, Math.round((now - lastAt.current) / 1000))} s. Se muestra lo último que llegó.`
            : "Esperando el primer estado del personaje…"}
    </span>
  );
  const label = demo === "off" || !connected ? "Sin conexión" : stale ? "Sin datos recientes" : "Conectando";

  return (
    <div className={`hud${online ? "" : " is-offline"}`} data-demo={demo ?? undefined}>
      <Header s={s} online={online} label={label} eta={eta} />
      <AlertStrip alerts={online ? alerts : []} offline={offline} />
      <div className="hud-body">
        <div className="hud-left">
          <Radar state={s} onRequestWarp={online ? () => setDialog("warp") : undefined} />
        </div>
        <div className="hud-right">
          <QuickActions s={s} send={run} disabled={disabled} open={setDialog} />
          <Tabs.Root value={tab} onValueChange={(v) => changeTab(String(v))} className="hud-tabs-root">
            <Tabs.List className="hud-tabs" aria-label="Información del personaje">
              {TABS.map(({ value, label: l, Icon }, i) => (
                <Tabs.Tab key={value} value={value} title={`${l} (${i + 1})`}>
                  <Icon size={14} aria-hidden />
                  <span>{"short" in TABS[i]! ? (TABS[i] as { short: string }).short : l}</span>
                </Tabs.Tab>
              ))}
              <button className="hud-help" onClick={() => setHelp(true)} aria-label="Atajos de teclado" title="Atajos (?)">
                <CircleHelp size={15} />
              </button>
            </Tabs.List>
            <Tabs.Panel value="overview" className="hud-tabpanel">
              <ExpCard s={s} samples={samples} eta={eta} now={now} />
              <SessionTiles s={s} now={now} />
              <Feed feed={feed} now={now} />
              {s && <Goldens s={s} />}
              <Journal decisions={decisions} now={now} limit={4} />
            </Tabs.Panel>
            <Tabs.Panel value="combat" className="hud-tabpanel">
              <SessionTiles s={s} now={now} />
              <Skills s={s} now={now} />
              {s && <Goldens s={s} />}
              {s && <Nearby s={s} />}
            </Tabs.Panel>
            <Tabs.Panel value="gear" className="hud-tabpanel">
              <Card title="Equipo" icon={<Shield size={14} />}>
                <Paperdoll items={s?.equipment ?? []} />
              </Card>
              <Card title="Bolsa" extra={<small>{(s?.inventory ?? []).length} ítems</small>}>
                <BagSummary items={s?.inventory ?? []} />
                <BagGrid items={s?.inventory ?? []} />
              </Card>
              <Stats s={s} />
            </Tabs.Panel>
            <Tabs.Panel value="events" className="hud-tabpanel">
              <EventsView s={s} now={now} />
            </Tabs.Panel>
            <Tabs.Panel value="commerce" className="hud-tabpanel">
              <CommerceView state={s} send={send} online={online} />
            </Tabs.Panel>
            <Tabs.Panel value="chat" className="hud-tabpanel">
              <ChatPanel chats={chats} result={result} send={send} disabled={disabled} />
            </Tabs.Panel>
            <Tabs.Panel value="journal" className="hud-tabpanel">
              <Journal decisions={decisions} now={now} />
            </Tabs.Panel>
            <Tabs.Panel value="console" className="hud-tabpanel">
              <Console logs={logs} />
            </Tabs.Panel>
          </Tabs.Root>
        </div>
      </div>

      <Confirm
        open={dialog === "farm"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={s?.mode === "hunt" ? "Dejar de cazar" : "Volver a la ruta normal"}
        description="El personaje cancela la cacería o suelta el spot fijo y sigue la ruta de farmeo automática. Si estaba en pausa, también la levanta."
        confirmLabel="Volver a la ruta"
        onConfirm={() => run({ cmd: "farm" })}
      />
      <Confirm
        open={dialog === "hunt"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Cazar dorados"
        description="El personaje deja de farmear y va a cazar dorados (corta solo a los 15 minutos o cuando no queden). Vuelve a la ruta con “Volver a la ruta”."
        confirmLabel="Cazar"
        onConfirm={() => run(hunt === "auto" ? { cmd: "hunt" } : { cmd: "hunt", map: +hunt })}
      >
        <div className="modal-field">
          <label>Mapa de cacería</label>
          <Choice label="Mapa de cacería" value={hunt} onChange={setHunt} items={hunts} />
        </div>
      </Confirm>
      <Confirm
        open={dialog === "warp"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Viajar a un spot"
        description={
          <>
            El personaje va a <b>{spotName}</b> y se queda fijo ahí hasta que le des “Volver a la ruta”. El viaje puede costar zen.
          </>
        }
        confirmLabel={`Ir a ${spotName}`}
        onConfirm={() => run({ cmd: "warp", warp: +warp })}
        disabled={!spots.length}
      >
        <div className="modal-field">
          <label>Destino</label>
          <Choice label="Destino" value={warp} onChange={setWarp} items={spots} />
        </div>
      </Confirm>
      <Modal open={help} onOpenChange={setHelp} title="Atajos de teclado">
        <div className="help-grid">
          {SHORTCUTS.map((g) => (
            <section key={g.group}>
              <h3>{g.group}</h3>
              {g.keys.map(([k, d]) => (
                <p key={k}>
                  <kbd>{k}</kbd>
                  <span>{d}</span>
                </p>
              ))}
            </section>
          ))}
        </div>
        <p className="modal-body">
          Las acciones que cambian lo que hace el personaje (volver a la ruta, cazar, viajar) siempre piden confirmación. Pausar y continuar son inmediatas.
          {demo && " Estás en modo demo: nada de lo que hagas llega a un personaje real."}
        </p>
      </Modal>
      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
      {demo === "on" && <div className="hud-demo">DEMO · datos simulados</div>}
    </div>
  );
}

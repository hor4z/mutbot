import { Radar } from "./Radar";
import { useBot } from "./useBot";

/** Solo el mapa del bot (radar a pantalla completa), para incrustar en la estación simple. */
export function MapOnly() {
  const { state } = useBot();
  return (
    <div className="maponly">
      <Radar state={state} />
    </div>
  );
}

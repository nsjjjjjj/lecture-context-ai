import type { ExperimentPanel } from "./components/ExperimentWorkspace";

export type AppRoute =
  | { page: "lecture" }
  | { page: "experiment"; panel: ExperimentPanel };

export const LECTURE_ROUTE: AppRoute = { page: "lecture" };

export function parseAppHash(hash: string): AppRoute {
  switch (hash) {
    case "#/experiment/setup":
      return { page: "experiment", panel: "setup" };
    case "#/experiment/record":
      return { page: "experiment", panel: "record" };
    case "#/experiment/run":
      return { page: "experiment", panel: "run" };
    case "#/experiment/results":
      return { page: "experiment", panel: "results" };
    case "#/lecture":
    default:
      return LECTURE_ROUTE;
  }
}

export function appRouteHash(route: AppRoute): string {
  return route.page === "lecture" ? "#/lecture" : `#/experiment/${route.panel}`;
}

export function resolveAppRoute(hash: string, development: boolean): AppRoute {
  const route = parseAppHash(hash);
  return development || route.page === "lecture" ? route : LECTURE_ROUTE;
}

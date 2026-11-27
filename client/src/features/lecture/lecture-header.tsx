import { ShieldCheck, Volume2 } from "lucide-react";
import type { AppStage as Stage } from "../../app-state";
import {
  appRouteHash,
  LECTURE_ROUTE,
  type AppRoute
} from "../../app-route";

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-10 place-items-center rounded-2xl bg-cyan-300 text-slate-950 shadow-[0_10px_30px_rgba(103,232,249,.18)]">
        <Volume2 className="size-5" strokeWidth={2.4} />
      </div>
      <div>
        <div className="text-[15px] font-extrabold tracking-[-0.03em] text-white">강연 용어 AI</div>
        <div className="text-[11px] font-medium tracking-[0.12em] text-slate-500">전문용어 자막·설명</div>
      </div>
    </div>
  );
}

export function Header({
  stage,
  route,
  development,
  experimentNavigationBlocked,
  onHome,
  onNavigate
}: {
  stage: Stage;
  route: AppRoute;
  development: boolean;
  experimentNavigationBlocked: boolean;
  onHome: () => void;
  onNavigate: (route: AppRoute) => void;
}) {
  const compact = stage === "live";
  const lectureActive = route.page === "lecture";
  const experimentActive = route.page === "experiment";
  const experimentRoute: AppRoute = experimentActive ? route : { page: "experiment", panel: "setup" };
  const primaryLinkClass = "inline-flex min-h-10 items-center justify-center rounded-xl px-4 text-xs font-extrabold outline-none ring-cyan-300 transition focus-visible:ring-2";

  return (
    <header className="relative z-20 border-b border-white/[0.06] bg-[#07111f]/85 backdrop-blur-xl">
      <div className={`mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-4 px-5 py-3 sm:px-8 ${compact ? "min-h-16" : "min-h-20"}`}>
        <button type="button" onClick={onHome} aria-label="처음 화면으로 이동" className="rounded-2xl text-left outline-none ring-cyan-300 focus-visible:ring-2">
          <Logo />
        </button>
        <nav aria-label="주요 메뉴" className="order-3 mt-3 w-full sm:order-none sm:mt-0 sm:w-auto">
          <ul className="flex items-center gap-1 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-1">
            <li className="min-w-0 flex-1 sm:flex-none">
              <a
                href="#/lecture"
                aria-current={lectureActive ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(LECTURE_ROUTE);
                }}
                className={`${primaryLinkClass} w-full ${lectureActive ? "bg-white text-slate-950" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}
              >
                강연
              </a>
            </li>
            {development && !experimentNavigationBlocked ? (
              <li className="min-w-0 flex-1 sm:flex-none">
                <a
                  href={appRouteHash(experimentRoute)}
                  aria-current={experimentActive ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(experimentRoute);
                  }}
                  className={`${primaryLinkClass} w-full ${experimentActive ? "bg-amber-200 text-slate-950" : "text-slate-400 hover:bg-amber-200/10 hover:text-amber-100"}`}
                >
                  STT 실험실
                </a>
              </li>
            ) : null}
          </ul>
        </nav>
        {lectureActive ? <div className="hidden items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.035] p-1 xl:flex">
          {["자료 분석", "전문용어 자막", "결과 확인"].map((label, index) => {
            const activeIndex = stage === "upload" || stage === "analyzing" || stage === "ready" ? 0 : stage === "live" ? 1 : 2;
            return (
              <div
                key={label}
                className={`rounded-full px-4 py-2 text-xs font-bold transition ${index === activeIndex ? "bg-white text-slate-950" : "text-slate-500"}`}
              >
                {index + 1}. {label}
              </div>
            );
          })}
        </div> : null}
        <div className="hidden items-center gap-2 text-xs font-semibold text-slate-400 lg:flex">
          <ShieldCheck className="size-4 text-emerald-300" />
          음성은 AWS로 실시간 전송 · 앱에 미저장
        </div>
      </div>
    </header>
  );
}



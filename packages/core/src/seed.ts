import type { AppState, OffDayMap } from "./types";
import { newId } from "./ids";
import { addDays, toISO } from "./dates";

/**
 * Seed / demo state — ported from the POC's "Sample Project".
 * Off-days are relative to today so the sample always looks current.
 */
export function seedState(): AppState {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Core Team — the main squad.
  const coreMembers = [
    { id: newId(), name: "Alice Kim", specialization: "Frontend" },
    { id: newId(), name: "Ben Osei", specialization: "Backend" },
    { id: newId(), name: "Chen Wu", specialization: "Backend" },
    { id: newId(), name: "Dara Singh", specialization: "QA" },
    { id: newId(), name: "Eva Torres", specialization: "Design" },
  ];
  const coreOffDays: OffDayMap = {};
  coreOffDays[coreMembers[0].id] = [
    toISO(addDays(today, 9)),
    toISO(addDays(today, 10)),
    toISO(addDays(today, 11)),
  ];
  coreOffDays[coreMembers[3].id] = [toISO(addDays(today, 3))];

  // Platform Team — a smaller second team, to show off multi-team planning.
  const platformMembers = [
    { id: newId(), name: "Farid Haddad", specialization: "Backend" },
    { id: newId(), name: "Grace Lin", specialization: "Frontend" },
  ];
  const platformOffDays: OffDayMap = {};

  return {
    projects: [
      {
        id: newId(),
        name: "Sample Project",
        startDate: toISO(today),
        plan: null,
        planViewMode: "person",
        helpers: [],
        epics: [
          {
            id: newId(),
            name: "Onboarding Flow",
            tasks: [
              {
                id: newId(),
                name: "Design onboarding screens",
                estimateDays: 3,
                specialization: "Design",
                excluded: false,
              },
              {
                id: newId(),
                name: "Build onboarding UI",
                estimateDays: 5,
                specialization: "Frontend",
                excluded: false,
              },
              {
                id: newId(),
                name: "Onboarding API",
                estimateDays: 4,
                specialization: "Backend",
                excluded: false,
              },
              {
                id: newId(),
                name: "QA pass",
                estimateDays: 2,
                specialization: "QA",
                excluded: false,
              },
            ],
          },
          {
            id: newId(),
            name: "Payments",
            tasks: [
              {
                id: newId(),
                name: "Payment provider research",
                estimateDays: 1,
                specialization: "Backend",
                excluded: true,
              },
              {
                id: newId(),
                name: "Checkout UI",
                estimateDays: 4,
                specialization: "Frontend",
                excluded: false,
              },
              {
                id: newId(),
                name: "Payment service integration",
                estimateDays: 6,
                specialization: "Backend",
                excluded: false,
              },
              {
                id: newId(),
                name: "Security review",
                estimateDays: 2,
                specialization: "QA",
                excluded: false,
              },
            ],
          },
        ],
      },
    ],
    teams: [
      {
        id: newId(),
        name: "Core Team",
        members: coreMembers,
        offDays: coreOffDays,
      },
      {
        id: newId(),
        name: "Platform Team",
        members: platformMembers,
        offDays: platformOffDays,
      },
    ],
  };
}

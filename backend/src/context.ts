import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { FetchLike } from './oauth.js';
import { UsersService } from './services/users.js';
import { CategoriesService } from './services/categories.js';
import { TransactionsService } from './services/transactions.js';
import { BudgetsService } from './services/budgets.js';
import { AlertService } from './services/alerts.js';
import { BudgetHub } from './ws/hub.js';

/** Everything a request handler needs: config, persistence, domain services, live hub. */
export interface AppContext {
  cfg: AppConfig;
  db: Db;
  users: UsersService;
  categories: CategoriesService;
  transactions: TransactionsService;
  budgets: BudgetsService;
  alerts: AlertService;
  hub: BudgetHub;
  /** Network boundary for the OAuth providers; tests inject a stub, so no real call happens. */
  fetchImpl: FetchLike;
}

export interface ContextParts {
  cfg: AppConfig;
  db: Db;
  fetchImpl: FetchLike;
}

export function createContext(parts: ContextParts): AppContext {
  const { cfg, db, fetchImpl } = parts;
  const alerts = new AlertService(db);
  const users = new UsersService(db);
  return {
    cfg,
    db,
    users,
    categories: new CategoriesService(db),
    transactions: new TransactionsService(db),
    budgets: new BudgetsService(db),
    alerts,
    // The hub resolves sockets through the same revocation-aware path as HTTP,
    // so a socket cannot outlive the session it was authenticated with.
    hub: new BudgetHub(cfg, alerts, users),
    fetchImpl,
  };
}

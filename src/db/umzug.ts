import { Umzug, SequelizeStorage } from "umzug";
import { QueryInterface } from "sequelize";
import { sequelize } from "./index";

// the glob matches .ts under tsx in dev and .js under dist in prod
export const umzug = new Umzug({
  migrations: { glob: ["migrations/*.{ts,js}", { cwd: __dirname }] },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: console,
});

// migrations get typed with this so `context` is the query interface
export type Migration = {
  name: string;
  up: (params: { context: QueryInterface }) => Promise<void>;
  down: (params: { context: QueryInterface }) => Promise<void>;
};

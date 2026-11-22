import { Umzug, SequelizeStorage } from "umzug";
import { QueryInterface } from "sequelize";
import { sequelize } from "./index";

// glob matches .ts under tsx in dev and .js under dist in prod. drop the
// extension before storing the name, or the same migration gets recorded as
// .ts locally and .js in docker and runs a second time.
export const umzug = new Umzug({
  migrations: {
    glob: ["migrations/*.{ts,js}", { cwd: __dirname }],
    resolve: ({ name, path, context }) => {
      const migration = require(path as string);
      return {
        name: name.replace(/\.(ts|js)$/, ""),
        up: () => migration.up({ context }),
        down: () => migration.down({ context }),
      };
    },
  },
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

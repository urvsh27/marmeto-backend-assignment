import { sequelize } from "./index";
import { umzug } from "./umzug";

// npm run migrate        -> apply everything pending
// npm run migrate down   -> roll back the last one
async function main() {
  const command = process.argv[2] ?? "up";

  if (command === "up") {
    const applied = await umzug.up();
    console.log(applied.length ? `applied ${applied.length} migration(s)` : "nothing to apply");
  } else if (command === "down") {
    await umzug.down();
  } else {
    console.error(`unknown command: ${command}`);
    process.exitCode = 1;
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

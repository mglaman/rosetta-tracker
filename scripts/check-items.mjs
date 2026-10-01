// @ts-check
import { ITEMS_PATH, readItems } from './items.mjs';

try {
  const { refs, problems } = await readItems();
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`${ITEMS_PATH} lists ${refs.length} work items.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

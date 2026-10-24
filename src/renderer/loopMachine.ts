/**
 * The loop specification and state machine moved to `src/main/loopMachine.ts`, because
 * the loop DRIVER now runs in main (see docs/loop-engineering-notes.md §13) and main
 * cannot import from the renderer. This file keeps the old import path working for the
 * renderer and the tests; there is exactly one copy of the machine.
 */
export * from '../main/loopMachine.ts';

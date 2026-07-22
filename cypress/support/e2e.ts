/**
 * E2E Test Support File
 *
 * This file runs before every E2E test and sets up global configuration,
 * custom commands, and event handlers.
 */

import "./commands";

/* -------------------------------------------------------------------------- */
/* Cypress Custom Commands for E2E Tests                                      */
/* -------------------------------------------------------------------------- */

declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Intercepts Chess.com API requests and serves fixture data.
       * @param gameId - The game ID to mock
       * @param fixturePath - Path to the fixture file (relative to fixtures/chesscom)
       */
      mockChessComGame(gameId: string, fixturePath?: string): Chainable<null>;

      /**
       * Waits for the page to fully load (no pending network requests).
       */
      waitForPageLoad(): Chainable<void>;

      /**
       * Loads a bughouse game by entering the game ID in the input.
       * @param gameId - The Chess.com game ID to load
       */
      loadGame(gameId: string): Chainable<void>;
    }
  }
}

/**
 * Mock Chess.com game API requests with fixture data.
 */
Cypress.Commands.add("mockChessComGame", (gameId: string, fixturePath?: string) => {
  const fixture = fixturePath ?? `chesscom/${gameId}.json`;
  cy.intercept(
    {
      method: "GET",
      url: `**/callback/live/game/${gameId}`,
    },
    { fixture },
  ).as(`chesscomGame-${gameId}`);
  return cy.wrap(null);
});

/**
 * Wait for page to stabilize (useful after navigation or data loading).
 */
Cypress.Commands.add("waitForPageLoad", () => {
  // Wait for any loading spinners to disappear
  cy.get("body").should("not.contain.text", "Loading...");
  // Give React time to hydrate
  cy.wait(100);
});

/**
 * Load a bughouse game by entering the game ID.
 */
Cypress.Commands.add("loadGame", (gameId: string) => {
  // Find the game ID input and enter the ID
  cy.get('input[placeholder*="Game ID"]').clear().type(gameId);
  // Click load button
  cy.get('button').contains(/load/i).click();
  // Wait for the game to load
  cy.waitForPageLoad();
});

/* -------------------------------------------------------------------------- */
/* Global Event Handlers                                                      */
/* -------------------------------------------------------------------------- */

Cypress.on("uncaught:exception", (err) => {
  const errorMessage = err.message || "";

  // Ignore hydration errors from Next.js (common in E2E tests)
  if (
    errorMessage.includes("Hydration failed") ||
    errorMessage.includes("There was an error while hydrating")
  ) {
    return false;
  }

  return true;
});

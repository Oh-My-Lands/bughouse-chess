import Sidebar from "../../app/components/layout/Sidebar";

describe("Sidebar", () => {
  it("renders the GitHub link with the correct href", () => {
    cy.mount(<Sidebar />);

    cy.get('a[aria-label="View source code on GitHub"]')
      .should("exist")
      .and("have.attr", "href", "https://github.com/Ellipsoul/bughouse-chess")
      .and("have.attr", "target", "_blank");
  });

  it("renders the play-on-chess.com link", () => {
    cy.mount(<Sidebar />);

    cy.get('a[aria-label="Play bughouse on Chess.com"]')
      .should("exist")
      .and("have.attr", "target", "_blank");
  });

  it("exposes a settings button", () => {
    cy.mount(<Sidebar />);

    cy.get('button[aria-label="Settings"]').should("exist");
  });

  it("has an accessible sidebar landmark", () => {
    cy.mount(<Sidebar />);

    cy.get('aside[aria-label="App sidebar"]').should("exist");
  });
});

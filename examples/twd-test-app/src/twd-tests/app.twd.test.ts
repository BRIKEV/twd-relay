import { twd, expect, userEvent } from "twd-js";
import { describe, it, beforeEach } from "twd-js/runner";


describe("App interactions", () => {
  beforeEach(() => {
    console.log("Reset state before each test");
    twd.clearRequestMockRules();
  });

  describe("nested level 1", () => {
    beforeEach(() => {
      console.log("Reset state before each test 1");
    });
    describe("nested level 2", () => {
      beforeEach(() => {
        console.log("Reset state before each test 2");
      });
      it("clicks the button", async () => {
        await twd.visit("/");
        const btn = await twd.get("button");
        userEvent.click(btn.el);
      });
    });
  });

  it.skip("skipped test", () => {
    throw new Error("Should not run");
  });

  it("test button", async () => {
    await twd.visit("/");
    const user = userEvent.setup();
    const btn = await twd.get("button");
    await user.click(btn.el);
    await userEvent.click(btn.el);
  });

  describe("Nested describe", () => {
    it("checks text content", async () => {
      await twd.visit("/");
      let input = await twd.get("input#simple-input");
      await userEvent.type(input.el, "hola");
      input = await twd.get("input#simple-input");
      input.should("have.value", "hola");
    });
  });

  it("fetches a joke and also tests retries in the waitForRequest command as we remove mocks and define it again before the wait", async () => {
    twd.clearRequestMockRules();
    await twd.visit("/");
    const btn = await twd.get("button[data-twd='joke-button']");
    await twd.notExists("p[data-twd='joke-text']");
    await twd.mockRequest("joke", {
      method: "GET",
      url: "https://api.chucknorris.io/jokes/random",
      response: {
        value: "Mocked joke!",
      },
    });
    await userEvent.click(btn.el);
    // Wait for the mock fetch to fire
    await twd.waitForRequest("joke");
    const jokeText = await twd.get("p[data-twd='joke-text']");
    // console.log(`Joke text: ${jokeText.el.textContent}`);
    jokeText.should("have.text", "Mocked joke!");
    // overwrite mid-test
    await twd.mockRequest("joke", {
      method: "GET",
      url: "https://api.chucknorris.io/jokes/random",
      response: {
        value: "Mocked second joke!",
      },
    });
    await userEvent.click(btn.el);
    await twd.waitForRequest("joke");
    const jokeText2 = await twd.get("p[data-twd='joke-text']");
    expect(jokeText2.el.textContent).to.equal("Mocked second joke!");
    jokeText2.should("have.text", "Mocked second joke!");
    // console.log(`Joke text: ${jokeText.el.textContent}`);
    // jokeText.should('be.disabled');
  });

  it("fetches a third joke to validate if the mocks are cleaned", async () => {
    await twd.mockRequest("joke", {
      method: "GET",
      url: "https://api.chucknorris.io/jokes/random",
      response: {
        value: "Third Mocked joke!",
      },
    });
    await twd.visit("/");
    const btn = await twd.get("button[data-twd='joke-button']");
    await userEvent.click(btn.el);
    // Wait for the mock fetch to fire
    await twd.waitForRequest("joke");
    const jokeText = await twd.get("p[data-twd='joke-text']");
    // console.log(`Joke text: ${jokeText.el.textContent}`);
    jokeText.should("have.text", "Third Mocked joke!");
  });
});

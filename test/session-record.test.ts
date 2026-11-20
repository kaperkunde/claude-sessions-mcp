import { describe, expect, it } from "vitest"

import { sessionRecord } from "../src/api.ts"

describe("sessionRecord", () => {
  it("unwraps one session's record as the API answers it", () => {
    expect(
      sessionRecord({ response_shape: { id: "cse_1", title: "A title" } }),
    ).toEqual({ id: "cse_1", title: "A title" })
  })

  it("takes a bare record as it is", () => {
    expect(sessionRecord({ id: "cse_1", title: "A title" })).toEqual({
      id: "cse_1",
      title: "A title",
    })
  })

  it("answers nothing for an answer it cannot read", () => {
    expect(sessionRecord(null)).toEqual({})
    expect(sessionRecord([{ id: "cse_1" }])).toEqual({})
    expect(sessionRecord({ response_shape: "x" })).toEqual({})
  })
})

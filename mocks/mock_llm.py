"""Deterministic LLM stub: fixed tokens and cost, no API spend."""


class MockLLM:
    def __init__(self, price_per_1k_in=0.0005, price_per_1k_out=0.0015, fixed_output_tokens=60):
        self.pin, self.pout, self.out_tokens = price_per_1k_in, price_per_1k_out, fixed_output_tokens

    def estimate(self, prompt):
        return round(self._tokens(prompt) / 1000 * self.pin + self.out_tokens / 1000 * self.pout, 6)

    @staticmethod
    def _tokens(prompt):
        return max(1, len(prompt.split()) * 2)

    def call(self, prompt):
        t_in = self._tokens(prompt)
        cost = round(t_in / 1000 * self.pin + self.out_tokens / 1000 * self.pout, 6)
        return {"text": f"[mock reply to: {prompt[:30]}]", "input_tokens": t_in,
                "output_tokens": self.out_tokens, "cost_usd": cost}

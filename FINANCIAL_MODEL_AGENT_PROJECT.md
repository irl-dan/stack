# Financial Model Agent Project

## Overview

You are building a sophisticated AI-powered financial modeling application that uses the **Claude Agents SDK** to generate comprehensive three-statement financial models with valuation analysis.

## The End Goal

Build a CLI application that, when run, produces:

> A three-statement working financial model driven by segment for Alphabet (GOOGL). With a valuation tab showing multiples for 2023-2030 and reverse DCF. Data sources: SEC filings from http://sec.gov and stock price from Google Finance.

## Project Location

Create all code in: `/Users/sl/code/flame/financial-model-agent/`

## Architecture Requirements

### 1. Claude Agents SDK Integration

Research and use the **Claude Agents SDK** (also known as `@anthropic-ai/agent-sdk` or similar). Key aspects:
- Agent orchestration patterns
- Tool definition and registration
- Multi-step reasoning with tool use
- Streaming responses
- Error handling and retries

### 2. Application Structure

```
financial-model-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # CLI entry point
│   ├── agents/
│   │   ├── orchestrator.ts   # Main agent that coordinates sub-agents
│   │   ├── data-fetcher.ts   # Agent for fetching SEC filings & stock data
│   │   ├── model-builder.ts  # Agent for building financial statements
│   │   └── valuation.ts      # Agent for DCF and multiples analysis
│   ├── tools/
│   │   ├── sec-fetcher.ts    # Tool to fetch SEC EDGAR filings
│   │   ├── stock-price.ts    # Tool to fetch stock prices
│   │   └── excel-writer.ts   # Tool to write Excel output
│   ├── models/
│   │   ├── income-statement.ts
│   │   ├── balance-sheet.ts
│   │   ├── cash-flow.ts
│   │   └── valuation.ts
│   └── utils/
│       ├── parser.ts         # Parse SEC filing data
│       └── calculator.ts     # Financial calculations
├── tests/
│   ├── judge/
│   │   ├── framework.ts      # LLM-as-judge test framework
│   │   └── criteria.ts       # Evaluation criteria
│   ├── agents/
│   │   └── *.test.ts
│   ├── tools/
│   │   └── *.test.ts
│   └── integration/
│       └── e2e.test.ts
└── output/
    └── (generated Excel files)
```

### 3. LLM-as-Judge Testing Framework

Implement a testing framework where Claude evaluates outputs:

```typescript
interface JudgeResult {
  pass: boolean;
  score: number;        // 0-100
  reasoning: string;
  suggestions: string[];
}

interface JudgeCriteria {
  name: string;
  description: string;
  weight: number;
}
```

Example criteria:
- **Data Accuracy**: Are the financial figures accurate to SEC filings?
- **Model Completeness**: Does the model include all three statements?
- **Segment Breakdown**: Is revenue properly segmented (Google Services, Cloud, Other Bets)?
- **Valuation Quality**: Are DCF assumptions reasonable? Are multiples appropriate?
- **Calculation Integrity**: Do the statements balance and flow correctly?

## Deliverables

### Phase 1: Research & Architecture
- [ ] Research Claude Agents SDK documentation and patterns
- [ ] Design the agent orchestration architecture
- [ ] Design the LLM-as-judge framework
- [ ] Document architectural decisions

### Phase 2: Core Implementation
- [ ] Set up project structure with TypeScript
- [ ] Implement SEC EDGAR data fetching tool
- [ ] Implement stock price fetching tool
- [ ] Implement the data-fetcher agent
- [ ] Implement income statement model
- [ ] Implement balance sheet model
- [ ] Implement cash flow statement model
- [ ] Implement the model-builder agent

### Phase 3: Valuation & Output
- [ ] Implement multiples analysis (P/E, EV/EBITDA, P/S for 2023-2030)
- [ ] Implement reverse DCF calculation
- [ ] Implement the valuation agent
- [ ] Implement Excel output generation
- [ ] Wire up the orchestrator agent

### Phase 4: Testing
- [ ] Implement LLM-as-judge framework
- [ ] Write unit tests for tools
- [ ] Write unit tests for models
- [ ] Write agent behavior tests
- [ ] Write integration tests
- [ ] Run all tests and fix failures

### Phase 5: First Run & Analysis
- [ ] Run the complete application
- [ ] Capture and review output
- [ ] Identify issues and gaps

### Phase 6: Improvements
- [ ] Propose improvements based on initial run
- [ ] Implement improvements
- [ ] Add tests for new functionality
- [ ] Rerun all tests

### Phase 7: Final Validation
- [ ] Run the application again
- [ ] Analyze output as a paying customer would
- [ ] Document final quality assessment

## Technical Notes

### SEC EDGAR API
- Base URL: `https://data.sec.gov/`
- Alphabet CIK: `0001652044`
- Relevant forms: 10-K (annual), 10-Q (quarterly)
- Rate limiting: Be respectful, use proper User-Agent

### Stock Price Data
- Consider Yahoo Finance API or similar
- Need historical prices for valuation multiples
- Current price for reverse DCF

### Three-Statement Model Components

**Income Statement:**
- Revenue by segment (Google Services, Google Cloud, Other Bets)
- Cost of revenues
- Operating expenses (R&D, Sales & Marketing, G&A)
- Operating income
- Net income

**Balance Sheet:**
- Current assets (Cash, Receivables, etc.)
- Non-current assets (PP&E, Intangibles)
- Current liabilities
- Non-current liabilities
- Stockholders' equity

**Cash Flow Statement:**
- Operating cash flow
- Investing cash flow
- Financing cash flow
- Net change in cash

### Valuation Components

**Multiples Analysis (2023-2030):**
- P/E ratio
- EV/EBITDA
- P/S ratio
- PEG ratio

**Reverse DCF:**
- Calculate implied growth rate from current stock price
- Sensitivity analysis on discount rate and terminal growth

## Success Criteria

The project is successful when:

1. **Functional**: The CLI runs without errors and produces output
2. **Accurate**: Financial data matches SEC filings
3. **Complete**: All three statements + valuation included
4. **Tested**: LLM-as-judge framework validates quality
5. **Professional**: Output suitable for financial analysis

## Important Notes

- Use the Flame tools (flame_push, flame_pop, flame_plan_children, etc.) to manage task complexity
- Break down large tasks into focused sub-frames
- Complete each frame before moving to the next
- Document decisions and results in each frame

Good luck!

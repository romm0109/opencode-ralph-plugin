---
name: create-prd
description: Create a Product Requirements Document from conversation
argument-hint: [output-filename]
metadata:
  short-description: Generate a product requirements document
---

# Create PRD: Generate Product Requirements Document

## Overview

Generate a comprehensive Product Requirements Document (PRD) based on the current conversation context and requirements discussed. Use the structure and sections defined below to create a thorough, professional PRD.

## Output File

Write the PRD to: `$ARGUMENTS` (default: `PRD.md`)

## PRD Structure

Create a well-structured PRD with the following sections. Adapt depth and detail based on available information:

### Required Sections

**1. Executive Summary**
- Concise product overview (2-3 paragraphs)
- Core value proposition
- MVP goal statement

**2. Mission**
- Product mission statement
- Core principles (3-5 key principles)

**3. Target Users**
- Primary user personas
- Technical comfort level
- Key user needs and pain points

**4. MVP Scope**
- **In Scope:** Core functionality for MVP (use ✅ checkboxes)
- **Out of Scope:** Features deferred to future phases (use ❌ checkboxes)
- Group by categories (Core Functionality, Technical, Integration, Deployment)

**5. User Stories**
- Primary user stories (5-8 stories) in format: "As a [user], I want to [action], so that [benefit]"
- Include concrete examples for each story
- Add technical user stories if relevant

**6. Core Architecture & Patterns**
- High-level architecture approach
- Directory structure (if applicable)
- Key design patterns and principles
- Technology-specific patterns

**7. Tools/Features**
- Detailed feature specifications
- If building an agent: Tool designs with purpose, operations, and key features
- If building an app: Core feature breakdown

**8. Technology Stack**
- Backend/Frontend technologies with versions
- Dependencies and libraries
- Optional dependencies
- Third-party integrations

**9. Security & Configuration**
- Authentication/authorization approach
- Configuration management (environment variables, settings)
- Security scope (in-scope and out-of-scope)
- Deployment considerations

**10. API Specification** (if applicable)
- Endpoint definitions
- Request/response formats
- Authentication requirements
- Example payloads

**11. Success Criteria**
- MVP success definition
- Functional requirements (use ✅ checkboxes)
- Quality indicators
- User experience goals

**12. Implementation Phases**
- Break down into 3-4 phases
- Each phase includes: Goal, Deliverables (✅ checkboxes), Validation criteria
- Realistic timeline estimates

**13. Future Considerations**
- Post-MVP enhancements
- Integration opportunities
- Advanced features for later phases

**14. Risks & Mitigations**
- 3-5 key risks with specific mitigation strategies

**15. Appendix** (if applicable)
- Related documents
- Key dependencies with links
- Repository/project structure

## Instructions

### 1. Extract Requirements
- Review the entire conversation history
- Identify explicit requirements and implicit needs
- Note technical constraints and preferences
- Capture user goals and success criteria

### 2. Synthesize Information
- Organize requirements into appropriate sections
- Fill in reasonable assumptions where details are missing
- Maintain consistency across sections
- Ensure technical feasibility

### 3. Write the PRD
- Use clear, professional language
- Include concrete examples and specifics
- Use markdown formatting (headings, lists, code blocks, checkboxes)
- Add code snippets for technical sections where helpful
- Keep Executive Summary concise but comprehensive

### 4. Quality Checks
- ✅ All required sections present
- ✅ User stories have clear benefits
- ✅ MVP scope is realistic and well-defined
- ✅ Technology choices are justified
- ✅ Implementation phases are actionable
- ✅ Success criteria are measurable
- ✅ Consistent terminology throughout

## Style Guidelines

- **Tone:** Professional, clear, action-oriented
- **Format:** Use markdown extensively (headings, lists, code blocks, tables)
- **Checkboxes:** Use ✅ for in-scope items, ❌ for out-of-scope
- **Specificity:** Prefer concrete examples over abstract descriptions
- **Length:** Comprehensive but scannable (typically 30-60 sections worth of content)

## Output Confirmation

After creating the PRD:
1. Confirm the file path where it was written
2. Provide a brief summary of the PRD contents
3. Highlight any assumptions made due to missing information
4. Suggest next steps (e.g., review, refinement, planning)

## Notes

- If critical information is missing, ask clarifying questions before generating
- Adapt section depth based on available details
- For highly technical products, emphasize architecture and technical stack
- For user-facing products, emphasize user stories and experience
- This command contains the complete PRD template structure - no external references needed


## Ralph local output and completion contract

This stage authors a feature PRD inside the owning run, not the repository root.
Use ralph_write_planning_file({runId, attempt, path: "PRD.md", content}) to write
all 15 sections (mark optional sections not applicable with reasons).
The stage prompt supplies runId, attempt and the exact draft directory.
Read repository context with observation tools. Ask missing product decisions with
the native question tool; do not silently invent them. Scope changes require a new
ralph_request_product_decision revisedExplanation and native approval before further authoring.
Do not implement project code, execute shell commands, delegate, or start planning.
Include the exact approved explanation revision/hash reference supplied by the host.
Finish by calling ralph_complete_prd({runId, attempt, path: "PRD.md"}).
Ordinary assistant prose does not complete this stage. The host validates and
publishes the accepted revision before handing off to issue planning.
This local output/completion contract overrides the generic output confirmation
and next-step suggestions above. Never write the project's root PRD.md.

## Stage-owned product questions

Call ralph_request_product_decision({runId, attempt, question, recommendation})
for missing product decisions. The host persists the request and real native answer.
A same-scope clarification continues in this stage without another approval.
If the answer changes scope, call the tool with revisedExplanation: {text, scope,
criteria}; the host always requests separate explanation approval and invalidates
dependent accepted drafts. Do not treat a clarification answer as scope approval.
Resume writing only from the revised stage prompt and its current artifact inputs.
Technical choices already within approved scope need no extra approval.

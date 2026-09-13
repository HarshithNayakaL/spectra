# Evaluation fixture matrix

| Fixture | Signal under test | Expected behavior |
| --- | --- | --- |
| clean-portfolio | Explicit identity and relationships | Person, created, works_at survive |
| ambiguous-portfolio | Conflicting role language | Identity ambiguity issue |
| b2b-company | Services, industries, geography | Organization contract |
| product-site | Product/spec relationships | Product retrieval queries |
| restaurant | Location, hours, menu | Local-business information classes |
| structured-rich | Valid JSON-LD | Structured evidence passes |
| structured-poor | Plain text only | JSON-LD recommendation |
| conflicting-descriptions | Metadata/body disagreement | Consistency issue |
| duplicate-content | Repeated fingerprints | Duplicate evidence warning |
| buried-information | Claim beyond shallow navigation | Survival failure at crawler |
| javascript-shell | Empty server HTML | Client-rendering limitation |

The checked-in crawler JSON is a deterministic local-development fixture. It is never presented as live target data.

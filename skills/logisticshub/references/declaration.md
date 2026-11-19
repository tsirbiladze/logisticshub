# Georgian goods declaration

Use `customs_declaration` for a Georgian goods declaration PDF or page image, including a draft. Use id `declaration` (then `declaration-2` for a second declaration). Record each fact with its exact quote and page. Leave an absent or unreadable fact null. Do not give a draft a registration or assessment date it does not print.

| Box | Header fields |
|---|---|
| A | `number`, `date` (registration only), `customsOfficeCode`, `customsOfficeName` |
| B | `assessmentNumber`, `assessmentDate`, when printed |
| 1 | `regime`, as printed (e.g. „იმ 4“) |
| 2, 8 | `exporter`, `importer`, respectively. Use the party fields, including printed `taxId` |
| 6 | `totalPackages`. Keep a printed packing word with the number in the quote |
| 15, 17 | `countryOfDispatch`, `countryOfDestination`, as printed |
| 22 | `currency`, `totalInvoiceAmount` |
| 23 | `exchangeRate` |
| 44 | `attachedDocuments[]`. Copy one entry per document, including its reference. Leave the list empty if none are printed |

Use one `items[]` entry per goods item, identified by box 32, including continuation pages. One item can cover several invoice lines. Keep their order and copy the printed fields.

| Box | Item fields |
|---|---|
| 31 | `description`, `packages` and `packingMethod` if printed |
| 32 | `itemNumber`, exactly as printed |
| 33 | `hsCode`, exactly as printed, including leading zeros |
| 34a | `countryOfOrigin`, including `999` if printed. Dispatch and origin are separate |
| 35, 38 | `grossWeightKg`, `netWeightKg`, respectively |
| 37 | `procedure`, exactly as printed |
| 41 | `supplementaryQuantity`, `supplementaryUnit`, separately |
| 42 | `invoiceValue`, in the invoice currency of box 22 |
| 46 | `customsValueGel`, in GEL |

Leave `sourceKind` null and every `rsValueInGel` fact null when reading a PDF or image. For a saved Revenue Service response use `declaration-from-rs`. It cites the response file and the JSON value, with null pages.

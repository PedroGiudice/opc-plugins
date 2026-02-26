---
name: search-book
description: |
  Search archive.org for books and texts using the Advanced Search API.
  Use when the user wants to find books, look up texts, search for
  publications by title/author/subject, or browse archive.org's text collection.
argument-hint: <query>
---

# Search Book on Archive.org

User request: $ARGUMENTS

## Instructions

1. Parse the user's request. Extract whatever is mentioned:
   - Book title → `title:("...")`
   - Author → `creator:(...)`
   - Subject/topic → `subject:(...)`
   - Language → `language:(...)`
   - Publisher → `publisher:(...)`
   - Date/year → `date:[YYYY TO YYYY]`
   - File format → `format:(...)` (optional, only if the user mentions a desired format)
   - If nothing specific is clear, use the whole query as general search terms

   **Format detection**: If the user mentions a file format like "pdf", "epub", "djvu", "kindle", or "txt" anywhere in the query, treat it as a format filter — not as part of the title or subject. Map common aliases:
   - pdf → `format:("Text PDF")`
   - epub → `format:(EPUB)`
   - djvu, djv → `format:(DjVu)`
   - kindle, mobi → `format:(Kindle)`
   - txt, text, plaintext → `format:("Text")`

2. Build a Lucene query. Always include `mediatype:texts`. Combine fields with `AND`.

3. Run the search via Bash:

```bash
curl -s -G 'https://archive.org/advancedsearch.php' \
  --data-urlencode 'q=mediatype:texts AND QUERY' \
  --data-urlencode 'fl[]=identifier' \
  --data-urlencode 'fl[]=title' \
  --data-urlencode 'fl[]=creator' \
  --data-urlencode 'fl[]=date' \
  --data-urlencode 'fl[]=language' \
  --data-urlencode 'fl[]=downloads' \
  --data-urlencode 'fl[]=subject' \
  --data-urlencode 'sort[]=downloads desc' \
  --data-urlencode 'rows=5' \
  --data-urlencode 'page=1' \
  --data-urlencode 'output=json'
```

Using `--data-urlencode` handles all encoding automatically (Cyrillic, spaces, special characters).

4. Format each result:

```
**N. Title**
   Author: ... | Date: ... | Language: ...
   Subject: ...
   Views: N
   https://archive.org/details/{identifier}
```

Note: The API field is called `downloads`, but archive.org displays it as "Views" on the website. Always label it **Views** in output.

End with: `Found N total results. Showing 1-5.`

5. If zero results — try broadening (see Query Tips below).

6. If the user asks for "more" — rerun with `page=2`, `page=3`, etc.

7. If the user picks a book — fetch details:

```bash
curl -s 'https://archive.org/metadata/{identifier}/metadata'
```

Show title, author, publisher, date, language, subject, description, and link `https://archive.org/details/{identifier}`.

## Lucene Query Syntax

| Operator | Example | Meaning |
|----------|---------|---------|
| `AND` | `title:(robots) AND creator:(Asimov)` | Both conditions |
| `OR` | `subject:(physics OR mathematics)` | Either condition |
| `NOT` | `creator:(Asimov) NOT title:(Foundation)` | Exclude |
| `"exact phrase"` | `title:("The Left Hand of Darkness")` | Exact match |
| `[A TO B]` | `date:[1950 TO 1960]` | Inclusive range |
| `*` | `title:(robot*)` | Wildcard |
| `~` | `title:(robtics~)` | Fuzzy match |

## Query Tips

- **Inconsistent metadata**: Try both last name (`creator:(Asimov)`) and full name (`creator:("Isaac Asimov")`). If one yields few results, try the other. Also try Latin transliteration for non-Latin authors.
- **Narrow vs. broad**: Start broad (just author or title), then add filters if too many results.
- **Exact phrases**: Use quotes for multi-word titles: `title:("The Lord of the Rings")`.
- **Date ranges**: `date:[1900 TO 1950]` for a period. Single year: `date:1984`.
- **Views (popularity)**: `sort[]=downloads desc` surfaces well-known editions first. The API field is `downloads`, but display it as "Views".
- **Language codes**: `eng`, `rus`, `fre`, `ger`, `spa`, `ita`, `chi`, `jpn`, `ara`.
- **Broadening on zero results**: Remove the most restrictive filter first, try alternate spellings, wildcards (`robot*`), or drop field prefixes to search all metadata.

## Error Handling

- **API error or timeout**: Retry once. If it fails again, tell the user archive.org may be temporarily unavailable.
- **Zero results**: Suggest broadening — alternate spellings, fewer filters, wildcards, try Latin transliteration.
- **Invalid identifier (404 on metadata)**: Suggest searching again.
- **Malformed JSON**: API may return HTML on rate limiting. Suggest trying again in a moment.

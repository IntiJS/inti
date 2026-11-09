# Every scenario carries a @verifiedBy:<path> tag with the test that
# checks it. packages/core/tests/specs.test.ts fails if the tag is missing or
# if the path does not exist: that way a specification cannot keep describing
# something that is no longer true without anyone noticing.

Feature: CLI inti sync - Introspection and types for blocks
  As a developer using Inti.js
  I want to sync my CMS schema locally
  To get autocompletion in my .astro blocks for what the adapter returns.

  @verifiedBy:packages/adapter-kitsuden/tests/adapter.test.ts
  Scenario: The adapter exposes the introspection contract
    Given the developer uses "KitsudenAdapter"
    When the system calls the "introspect()" method
    Then the adapter must read the CMS block palette
    And it must return a "Page" collection and one for each type in the palette
    And each block collection must declare in "blockType" the same type that "parsePage" assigns
    And it must not fail if the palette is empty.

  @verifiedBy:packages/adapter-wordpress/tests/adapter.test.ts
  Scenario: WordPress describes its Flexible Content layouts
    Given the CMS is WordPress with blocks in ACF Flexible Content
    When the system calls "introspect()"
    Then it must return one collection for each layout present in the sample page
    And its "blockType" must honor "blockTypeMap", just like "parsePage"
    And two different sites in the same process must not share the cached schema.

  @verifiedBy:packages/cli/tests/generator.test.ts
  Scenario: Generating inti.types.ts
    Given the CLI receives a valid schema from the adapter
    When the generator processes the schema
    Then it must produce "inti.types.ts" with one exported interface per collection
    And the file must compile with "tsc --strict" with only "@intijs/core" installed
    And dates must be typed as ISO strings, not as Date
    And images must accept either an id or an object with a url.

  @verifiedBy:packages/cli/tests/generator.test.ts
  Scenario: Typed page blocks
    Given the schema describes the CMS block types
    When the developer casts "page.blocks" to "IntiTypedBlock[]"
    Then checking "block.type" must leave "block.data" typed for that block
    And accessing a field of another block type must be a compile error
    And comparing against a type that does not exist in the CMS must be a compile error.

  @verifiedBy:packages/adapter-wordpress/tests/acf-write.test.ts @verifiedBy:scripts/wordpress-check.mjs
  Scenario: Saving a page with images and relations
    Given a WordPress page with an image, a gallery, a relation and a link
    When an editor saves another field
    Then WordPress must accept the write
    And none of those values must change.

  @verifiedBy:packages/core/tests/drafts.test.ts @verifiedBy:scripts/wordpress-check.mjs
  Scenario: Changing a page without the visitor seeing it
    Given a published page
    When an editor creates a draft and edits it
    Then a visitor must keep seeing the published version, also with "?inti-draft=1"
    And publishing the draft must bring the changes to the page.

  @verifiedBy:packages/core/tests/edit-history.test.ts
  Scenario: Undoing a text edit
    Given a field edited and saved
    When the editor undoes
    Then the previous value must be written with a normal write
    And if that write fails the edit must be retryable.

  @verifiedBy:packages/genui/tests/genui.test.ts
  Scenario: The model cannot invent data or markup
    Given a vocabulary with a reference to products
    When the model returns a nonexistent id, an undeclared field or a javascript: link
    Then it must be discarded and reported
    And a product's price must always come from the server.

  @verifiedBy:scripts/genui-check.mjs
  Scenario: A proposal writes nothing until accepted
    Given an editor who asks for a proposal
    When the blocks arrive and are previewed with the real components
    Then nothing must be written to the CMS
    And accepting it must go through the action with permissions.

  @verifiedBy:packages/genui/tests/genui.test.ts @verifiedBy:scripts/genui-check.mjs
  Scenario: Composition during the visit
    Given a public search box
    When a visitor makes requests
    Then there must be a per-visitor limit and a daily cap
    And the response must not be indexable
    And a model failure must not break the page.

  @verifiedBy:packages/core/tests/adapt.test.ts @verifiedBy:scripts/genui-check.mjs
  Scenario: Choosing a zone's version without AI
    Given several versions of a zone with their audience
    When a visitor arrives
    Then they must receive the most specific one that matches, without JavaScript
    And a search engine must always receive the default content
    And "meta.index" must not be renumbered.

  @verifiedBy:scripts/genui-check.mjs
  Scenario: The adapted response does not go to a shared cache
    Given a page with per-visitor versions
    When it is served
    Then it must carry "Cache-Control: private" and "Vary: Cookie".

  @verifiedBy:packages/core/tests/adapt.test.ts @verifiedBy:scripts/genui-check.mjs
  Scenario: Observing requires consent
    Given a visitor without consent
    When they browse
    Then they must not receive an identifier nor have what they visit counted
    And withdrawing consent must delete it.

  @verifiedBy:packages/mcp/tests/server-e2e.test.ts
  Scenario: An agent composes over MCP
    Given the MCP server started over stdio
    When an agent reads, edits, creates a draft and publishes it
    Then the changes must reach the CMS
    And with a vocabulary, what is not declared must not be written.

  @verifiedBy:scripts/kitsuden-check.mjs @verifiedBy:packages/adapter-kitsuden/tests/write-back.test.ts
  Scenario: Editing and publishing against a real instance
    Given a disposable Kitsuden and an agent key
    When it edits, inserts, moves and deletes
    Then the API must return those changes
    And a draft must not be visible until it is published
    And a hidden block must stay hidden in its place.

  @verifiedBy:packages/adapter-kitsuden/tests/ordering-visibility.test.ts
  Scenario: A model cannot invent a Kitsuden media item
    Given the Kitsuden palette with a "mediaId" field
    When the vocabulary is derived without a media source
    Then that field must not be offered
    And with a source it must be a reference to what exists.

  @verifiedBy:packages/adapter-keystatic/tests/adapter.test.ts
  Scenario: What is written, Keystatic reads
    Given a Keystatic collection with a blocks field
    When Inti edits, inserts or publishes a draft
    Then the official Keystatic reader must read the result
    And a slug must not be able to leave the folder
    And a foreign change on GitHub must not be overwritten.

  @verifiedBy:scripts/cloudflare-check.mjs
  Scenario: A site works on workerd
    Given a project with local @astrojs/cloudflare, D1, R2 and Durable Objects
    When it reads, edits, publishes a draft and uploads an image
    Then the content must persist
    And concurrent writes must not overwrite each other
    And a fake image must not be accepted.

  @verifiedBy:scripts/cloudflare-check.mjs
  Scenario: One editing room per document
    Given two editors on one document and one on another
    When one sends a change
    Then it must reach only those on its document, with its real identity
    And whoever joins later must receive what came before.

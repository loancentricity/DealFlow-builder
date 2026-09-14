ALTER TABLE builds DROP CONSTRAINT builds_prompt_check;
ALTER TABLE builds ADD CONSTRAINT builds_prompt_check CHECK(length(prompt) BETWEEN 1 AND 60000);

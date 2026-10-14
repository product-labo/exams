CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE courses (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  num_questions INT NOT NULL DEFAULT 10,        -- questions drawn per attempt
  exam_seconds INT NOT NULL DEFAULT 600,        -- overall exam limit
  seconds_per_question INT NOT NULL DEFAULT 10, -- countdown after narration
  max_repeats INT NOT NULL DEFAULT 1,           -- repeats allowed per question
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE questions (
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  options JSONB NOT NULL,                       -- ["Paris","Rome","Madrid"]
  correct_option CHAR(1) NOT NULL,              -- 'A'..'D'
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON questions(course_id, status);

CREATE TABLE students (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE exam_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id INT NOT NULL REFERENCES courses(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  score INT NOT NULL DEFAULT 0,
  total INT NOT NULL
);

CREATE TABLE session_questions (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  question_id INT NOT NULL REFERENCES questions(id),
  position INT NOT NULL,
  served_at TIMESTAMPTZ,
  deadline TIMESTAMPTZ,                         -- set when narration finishes
  repeats_used INT NOT NULL DEFAULT 0,
  answer CHAR(1),
  is_correct BOOLEAN,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','answered','timeout')),
  UNIQUE (session_id, question_id),             -- a question never repeats in one attempt
  UNIQUE (session_id, position)
);

CREATE TABLE exam_results (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL UNIQUE REFERENCES exam_sessions(id),
  student_id INT NOT NULL REFERENCES students(id),
  course_id INT NOT NULL REFERENCES courses(id),
  score INT NOT NULL,
  total_possible INT NOT NULL,
  percentage NUMERIC(5,2) NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_hash TEXT NOT NULL,
  tx_hash TEXT,
  chain TEXT
);

-- Course material + AI generation (added after v1)
ALTER TABLE courses ADD COLUMN material TEXT;
ALTER TABLE courses ADD COLUMN auto_publish BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE generation_jobs (
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  target INT NOT NULL,
  created INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE students ADD COLUMN wallet TEXT;

-- Pay-to-reveal (wallet-bound results)
ALTER TABLE exam_results ADD COLUMN wallet TEXT NOT NULL DEFAULT '';
ALTER TABLE exam_results ADD COLUMN paid_at TIMESTAMPTZ;
ALTER TABLE exam_results ADD COLUMN expires_at TIMESTAMPTZ;
CREATE INDEX ON exam_results (lower(wallet));
ALTER TABLE courses ADD COLUMN material_files JSONB NOT NULL DEFAULT '[]';

-- Course modules: one uploaded file = one module
CREATE TABLE course_materials (
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','failed')),
  error TEXT,
  progress_done INT NOT NULL DEFAULT 0,
  progress_total INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE questions ADD COLUMN material_id INT REFERENCES course_materials(id) ON DELETE SET NULL;

-- What the speech engine returned and what the agent decided; used to diagnose "it does not hear me"
CREATE TABLE utterance_log (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  position INT,
  heard TEXT,
  alternatives JSONB,
  action TEXT NOT NULL,
  letter CHAR(1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON utterance_log (session_id, id);

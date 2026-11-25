#!/bin/bash
# Fresh database → Supabase stand-ins → supabase/setup.sql → tests as the browser roles.
set -e
cd "$(dirname "$0")/.."
su postgres -c "dropdb --if-exists sbtest; createdb sbtest" 2>/dev/null
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d sbtest -f tests/supabase_sim.sql -f supabase/setup.sql" >/dev/null
su postgres -c "psql -q -X -t -A -d sbtest -f tests/test_supabase.sql" 2>&1 | grep -v '^set_config\|^$\|^[0-9a-f-]\{36\}$'

# Exploration uses the regular agent loop

The `/explore` workflow uses Pi's regular agent loop for its repository overview and selected-flow investigation, with read-only tools active for the duration of exploration. This reuses Pi's existing model and tool lifecycle and leaves the investigation visible in the session transcript; a private runner would isolate that activity but duplicate harness behavior.

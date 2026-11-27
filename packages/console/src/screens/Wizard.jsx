// First-run wizard (PORCH-130): one surface, three steps — name the
// deployment, say who you are, finish setup and land inside. There is no
// account anywhere in setup: it asks for the deployment's name, your name,
// and nothing else. Every refusal is earned: a submit that fails shows the
// server's own plain-language words inline, loading states never render as
// errors, and the picture upload is size-gated here before anything leaves
// the device.
import React, { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Stepper from "@mui/material/Stepper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

// props {} by contract: Wizard owns its setup conversation, so it imports
// the console's api instance directly.
import { api } from "../api.js";

// A picture larger than this never leaves the device — the refusal is
// inline, plain-language, and earned at pick time.
const MAX_PHOTO_BYTES = 1_500_000;

export default function Wizard({ onComplete }) {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState("");

  const [deploymentName, setDeploymentName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [photo, setPhoto] = useState(null); // data URL of a newly picked picture

  const [nameNote, setNameNote] = useState("");
  const [nameError, setNameError] = useState("");
  const [ownerError, setOwnerError] = useState("");
  const [ownerNote, setOwnerNote] = useState("");
  const [photoNote, setPhotoNote] = useState("");
  const [finishError, setFinishError] = useState("");
  const [busy, setBusy] = useState(false);

  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await api.getSetup();
        if (cancelled) return;
        setDeploymentName(state?.deployment?.name ?? "");
        if (state?.owner != null) {
          setFirstName(state.owner.firstName ?? "");
          setLastName(state.owner.lastName ?? "");
          if (state.owner.photo === true) {
            const photoState = await api.getSetupPhoto().catch(() => null);
            if (!cancelled && photoState?.photo) setPhoto(photoState.photo);
          }
        }
        setBootError("");
      } catch (failure) {
        if (!cancelled) setBootError(failure.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- setup loads once per mount

  async function saveDeployment() {
    setBusy(true);
    setNameError("");
    try {
      await api.putSetupDeployment(deploymentName.trim());
      setNameNote(deploymentName.trim());
      setStep(1);
    } catch (failure) {
      setNameError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  function pickPhoto(event) {
    setPhotoNote("");
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPhotoNote("That file is not a picture — choose an image, or leave it out.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoNote("That picture is too large — pick one under 1.5 MB, or leave it out.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result ?? ""));
    reader.onerror = () => setPhotoNote("The picture could not be read on this device — pick another, or leave it out.");
    reader.readAsDataURL(file);
  }

  async function saveOwner() {
    if (!firstName.trim() || !lastName.trim()) {
      setOwnerNote("Both names are needed — first and last.");
      return;
    }
    setBusy(true);
    setOwnerError("");
    try {
      const body = { firstName: firstName.trim(), lastName: lastName.trim() };
      if (photo !== null) body.photo = photo; // absent = keep what's stored, null = clear
      await api.putSetupOwner(body);
      setStep(2);
    } catch (failure) {
      setOwnerError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setFinishError("");
    try {
      await api.completeSetup();
      onComplete?.();
    } catch (failure) {
      setFinishError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const steps = ["Name the deployment", "Who you are", "Finish setup"];

  if (loading) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <Typography color="text.secondary">Opening setup…</Typography>
      </Box>
    );
  }

  if (bootError) {
    return (
      <Paper variant="outlined" sx={{ p: 3, maxWidth: 520, mx: "auto", textAlign: "center" }}>
        <Typography color="error" sx={{ mb: 2 }}>
          Setup could not be reached: {bootError}
        </Typography>
        <Button variant="outlined" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 3, sm: 4 }, maxWidth: 560, mx: "auto" }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            Setting up Porchlight
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Setup covers only what the three steps below ask for — your own device and your own answers. It never asks for anything more: nothing extra gets collected, stored elsewhere, or requested from another service.
          </Typography>
        </Box>

        <Stepper activeStep={step} alternativeLabel>
          {steps.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {step === 0 && (
          <Stack spacing={2} component="form" onSubmit={(event) => event.preventDefault()}>
            <TextField
              label="What should this deployment be called?"
              value={deploymentName}
              onChange={(event) => setDeploymentName(event.target.value)}
              fullWidth
              autoFocus
            />
            {nameError && <Typography color="error">{nameError}</Typography>}
            <Button variant="contained" onClick={saveDeployment} disabled={busy}>
              Continue
            </Button>
          </Stack>
        )}

        {step === 1 && (
          <Stack spacing={2} component="form" onSubmit={(event) => event.preventDefault()}>
            <TextField
              label="First name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
            <TextField
              label="Last name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              required
            />
            <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}>
              {photo && (
                <Box
                  component="img"
                  src={photo}
                  alt="The picture kept for this deployment"
                  sx={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", bgcolor: "action.hover" }}
                />
              )}
              <Button variant="outlined" onClick={() => fileRef.current?.click()}>
                {photo ? "Replace the picture" : "Add a picture"}
              </Button>
              {photo && (
                <Button
                  variant="text"
                  onClick={() => {
                    setPhoto(null);
                    setPhotoNote("The picture will be removed when you continue.");
                  }}
                >
                  Leave it out
                </Button>
              )}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
            </Stack>
            {photoNote && <Typography color="text.secondary">{photoNote}</Typography>}
            {!firstName.trim() || !lastName.trim() ? (
              ownerNote && <Typography color="text.secondary">{ownerNote}</Typography>
            ) : null}
            {ownerError && <Typography color="error">{ownerError}</Typography>}
            <Button variant="contained" onClick={saveOwner} disabled={busy}>
              Continue
            </Button>
          </Stack>
        )}

        {step === 2 && (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              {deploymentName ? `Everything is ready — the deployment is called ${deploymentName}.` : "Everything is ready."}
              {firstName && lastName ? ` It belongs to ${firstName} ${lastName}.` : ""}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Finishing setup records these answers and opens the console — your cameras, their timelines, and the live views all land behind one tap.
            </Typography>
            {finishError && <Typography color="error">{finishError}</Typography>}
            <Button variant="contained" onClick={finish} disabled={busy}>
              Finish setup
            </Button>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

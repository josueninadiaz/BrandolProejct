const SUPABASE_CONFIG = {
  url: "https://qfofowchmxrunpeyfvkc.supabase.co",
  publishableKey: "sb_publishable_PN1WQLeECnJ18sotKj4KMw_7zm5M-9-",
  profilesTable: "profiles",
  applicationsTable: "job_applications",
  assetsBucket: "candidate-assets",
  loginResolverRpc: "resolve_login_email",
};

const MOOGLE_PREFILL_KEY = "thesikkerhet.moogle.prefill";

const appState = {
  currentView: "login",
  session: null,
  user: null,
  profile: null,
  authSettings: null,
  setupIssues: [],
};

let elements = {};
let supabaseClient = null;

const authCopy = {
  login: {
    title: "Inicia sesión",
    subtitle: "Accede a tu perfil de candidato y continúa con tu solicitud.",
    chip: "Acceso seguro",
    iconClass: "fa-solid fa-fingerprint",
  },
  register: {
    title: "Crea tu cuenta",
    subtitle: "Registra tu perfil y conéctalo con Supabase Auth y tu base de reclutamiento.",
    chip: "Onboarding",
    iconClass: "fa-solid fa-user-plus",
  },
};

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error(error);
    showSystemBanner(
      "error",
      "No se pudo inicializar la conexión con Supabase. Revisa la configuración del proyecto y vuelve a cargar."
    );
  });
});

async function bootstrap() {
  cacheElements();
  bindEvents();
  setAuthView(resolveInitialAuthView());
  showAuthView();
  hydrateAuthPrefill();
  initializeSupabaseClient();

  await Promise.allSettled([loadAuthSettings(), checkProjectResources()]);
  await restoreSession();
  registerAuthListener();
  syncGoogleButtonState();
}

function cacheElements() {
  elements = {
    systemBanner: document.getElementById("system-banner"),
    authShell: document.getElementById("auth-shell"),
    applicationShell: document.getElementById("application-shell"),
    authTitle: document.getElementById("auth-title"),
    authSubtitle: document.getElementById("auth-subtitle"),
    authChip: document.getElementById("auth-chip"),
    authIcon: document.getElementById("auth-icon"),
    authMessage: document.getElementById("auth-message"),
    applicationMessage: document.getElementById("application-message"),
    loginForm: document.getElementById("login-form"),
    registerForm: document.getElementById("register-form"),
    applicationForm: document.getElementById("application-form"),
    showRegisterButton: document.getElementById("show-register"),
    showLoginButton: document.getElementById("show-login"),
    googleLoginButton: document.getElementById("google-login"),
    logoutButton: document.getElementById("logout-button"),
    sessionChip: document.getElementById("session-chip"),
    sessionChipText: document.getElementById("session-chip-text"),
    candidateName: document.getElementById("candidate-name"),
  };
}

function bindEvents() {
  elements.showRegisterButton.addEventListener("click", () => setAuthView("register"));
  elements.showLoginButton.addEventListener("click", () => setAuthView("login"));
  elements.googleLoginButton.addEventListener("click", handleGoogleLogin);
  elements.loginForm.addEventListener("submit", handleLoginSubmit);
  elements.registerForm.addEventListener("submit", handleRegisterSubmit);
  elements.applicationForm.addEventListener("submit", handleApplicationSubmit);
  elements.logoutButton.addEventListener("click", handleLogout);
}

function initializeSupabaseClient() {
  if (!window.supabase?.createClient) {
    throw new Error("La libreria de Supabase no se cargó correctamente.");
  }

  supabaseClient = window.supabase.createClient(
    SUPABASE_CONFIG.url,
    SUPABASE_CONFIG.publishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }
  );
}

async function loadAuthSettings() {
  const response = await fetch(`${SUPABASE_CONFIG.url}/auth/v1/settings`, {
    headers: {
      apikey: SUPABASE_CONFIG.publishableKey,
    },
  });

  if (!response.ok) {
    throw new Error("No se pudieron consultar los ajustes de autenticación del proyecto.");
  }

  appState.authSettings = await response.json();
}

async function checkProjectResources() {
  const checks = await Promise.allSettled([
    checkSelectQuery(SUPABASE_CONFIG.profilesTable, "id,username"),
    checkSelectQuery(SUPABASE_CONFIG.applicationsTable, "id,desired_position"),
    checkRpcExists(SUPABASE_CONFIG.loginResolverRpc),
  ]);

  const issues = [];

  checks.forEach((result) => {
    if (result.status === "fulfilled" && result.value) {
      issues.push(result.value);
    }

    if (result.status === "rejected") {
      issues.push("No se pudo validar completamente el esquema de Supabase.");
    }
  });

  appState.setupIssues = issues.filter(Boolean);

  if (appState.setupIssues.length > 0) {
    showSystemBanner(
      "error",
      "Faltan recursos en Supabase. Ejecuta `supabase-setup.sql` en el SQL Editor antes de usar registro, login por usuario y postulaciones."
    );
    return;
  }

  clearSystemBanner();
}

async function checkSelectQuery(tableName, selectFields) {
  const response = await fetch(
    `${SUPABASE_CONFIG.url}/rest/v1/${tableName}?select=${encodeURIComponent(selectFields)}&limit=1`,
    {
      headers: {
        apikey: SUPABASE_CONFIG.publishableKey,
      },
    }
  );

  if (response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  const message = payload?.message || "";

  if (
    message.includes("schema cache") ||
    message.includes(`public.${tableName}`) ||
    message.includes("Could not find the")
  ) {
    return tableName;
  }

  return null;
}

async function checkRpcExists(functionName) {
  const response = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_CONFIG.publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      login_identifier: "__schema_check__",
    }),
  });

  if (response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  const message = payload?.message || "";

  if (message.includes(functionName) || message.includes("Could not find")) {
    return functionName;
  }

  return null;
}

async function restoreSession() {
  const {
    data: { session },
    error,
  } = await supabaseClient.auth.getSession();

  if (error) {
    throw error;
  }

  await syncSession(session);
}

function registerAuthListener() {
  supabaseClient.auth.onAuthStateChange((event, session) => {
    window.setTimeout(() => {
      syncSession(session).catch((error) => {
        console.error(error);
        showSystemBanner("error", translateSupabaseError(error, "session"));
      });

      if (event === "SIGNED_OUT") {
        clearMessage(elements.applicationMessage);
        showMessage(
          elements.authMessage,
          "info",
          "Sesión cerrada. Puedes volver a iniciar sesión cuando quieras."
        );
      }
    }, 0);
  });
}

async function syncSession(session) {
  appState.session = session || null;
  appState.user = session?.user || null;

  if (!appState.user) {
    appState.profile = null;
    elements.applicationForm.reset();
    setAuthView(resolveInitialAuthView());
    hydrateAuthPrefill();
    showAuthView();
    return;
  }

  appState.profile = await ensureProfileForUser(appState.user);
  clearMooglePrefill();
  showApplicationView(appState.profile || buildFallbackProfile(appState.user));
}

function setAuthView(view) {
  appState.currentView = view;
  const copy = authCopy[view];
  const isLogin = view === "login";

  elements.loginForm.classList.toggle("hidden", !isLogin);
  elements.registerForm.classList.toggle("hidden", isLogin);
  elements.authTitle.textContent = copy.title;
  elements.authSubtitle.textContent = copy.subtitle;
  elements.authChip.innerHTML = `<i class="fa-solid ${isLogin ? "fa-lock" : "fa-user-shield"} text-brand-400"></i>${copy.chip}`;
  elements.authIcon.className = `${copy.iconClass} text-xl`;
  clearFieldErrors(elements.loginForm);
  clearFieldErrors(elements.registerForm);
  clearMessage(elements.authMessage);
}

function showAuthView() {
  elements.authShell.classList.remove("hidden");
  elements.applicationShell.classList.add("hidden");
  elements.logoutButton.classList.add("hidden");
  elements.sessionChip.classList.add("hidden");
}

function showApplicationView(profile) {
  elements.authShell.classList.add("hidden");
  elements.applicationShell.classList.remove("hidden");
  elements.logoutButton.classList.remove("hidden");
  elements.sessionChip.classList.remove("hidden");
  elements.sessionChip.classList.add("inline-flex");

  const displayName =
    profile?.full_name ||
    appState.user?.user_metadata?.full_name ||
    appState.user?.email ||
    "Perfil autenticado";

  elements.sessionChipText.textContent = `Hola, ${displayName}`;
  elements.candidateName.textContent = displayName;
  applyApplicationDefaults();
}

function syncGoogleButtonState() {
  const googleEnabled = Boolean(appState.authSettings?.external?.google);

  if (!googleEnabled) {
    elements.googleLoginButton.title = "Google Auth no está activado todavía. La página puente te lo indicará.";
  } else {
    elements.googleLoginButton.removeAttribute("title");
  }
}

async function handleGoogleLogin() {
  window.location.href = "google-auth.html";
}

function resolveInitialAuthView() {
  const params = new URLSearchParams(window.location.search);
  const requestedView = String(params.get("view") || "").trim().toLowerCase();
  return requestedView === "register" ? "register" : "login";
}

function hydrateAuthPrefill() {
  const params = new URLSearchParams(window.location.search);
  const queryIdentifier = String(params.get("identifier") || "").trim();
  const storedIdentifier = String(window.localStorage.getItem(MOOGLE_PREFILL_KEY) || "").trim();
  const resolvedIdentifier = queryIdentifier || storedIdentifier;

  if (!resolvedIdentifier) {
    return;
  }

  if (elements.loginForm?.elements?.identifier && !elements.loginForm.elements.identifier.value) {
    elements.loginForm.elements.identifier.value = resolvedIdentifier;
  }

  if (
    isValidEmail(resolvedIdentifier) &&
    elements.registerForm?.elements?.correo &&
    !elements.registerForm.elements.correo.value
  ) {
    elements.registerForm.elements.correo.value = resolvedIdentifier;
  }
}

function clearMooglePrefill() {
  window.localStorage.removeItem(MOOGLE_PREFILL_KEY);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  clearFieldErrors(elements.loginForm);
  clearMessage(elements.authMessage);

  const formData = new FormData(elements.loginForm);
  const identifier = String(formData.get("identifier") || "").trim();
  const password = String(formData.get("password") || "").trim();
  let hasErrors = false;

  if (!identifier) {
    setFieldError(elements.loginForm, "identifier", "Ingresa tu usuario o correo.");
    hasErrors = true;
  }

  if (!password) {
    setFieldError(elements.loginForm, "password", "Ingresa tu contraseña.");
    hasErrors = true;
  }

  if (hasErrors) {
    showMessage(elements.authMessage, "error", "Corrige los campos marcados antes de continuar.");
    return;
  }

  const submitButton = elements.loginForm.querySelector('button[type="submit"]');
  setLoadingState(submitButton, true, "Validando...");

  try {
    const email = await normalizeLoginIdentifier(identifier);

    const { error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      throw error;
    }

    elements.loginForm.reset();
    clearMooglePrefill();
    showMessage(
      elements.applicationMessage,
      "success",
      "Sesión iniciada correctamente. Ya puedes completar y enviar tu solicitud."
    );
  } catch (error) {
    showMessage(elements.authMessage, "error", translateSupabaseError(error, "login"));
  } finally {
    setLoadingState(submitButton, false, "Iniciar sesión");
  }
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  clearFieldErrors(elements.registerForm);
  clearMessage(elements.authMessage);

  const formData = new FormData(elements.registerForm);
  const payload = {
    nombre: String(formData.get("nombre") || "").trim(),
    usuario: String(formData.get("usuario") || "").trim(),
    correo: String(formData.get("correo") || "").trim(),
    password: String(formData.get("password") || "").trim(),
  };
  const confirmPassword = String(formData.get("confirmPassword") || "").trim();

  const errors = validateRegistration(payload, confirmPassword);

  if (Object.keys(errors).length > 0) {
    Object.entries(errors).forEach(([field, message]) => setFieldError(elements.registerForm, field, message));
    showMessage(elements.authMessage, "error", "Revisa el formulario antes de registrarte.");
    return;
  }

  const submitButton = elements.registerForm.querySelector('button[type="submit"]');
  setLoadingState(submitButton, true, "Registrando...");

  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email: payload.correo,
      password: payload.password,
      options: {
        emailRedirectTo: window.location.href,
        data: {
          full_name: payload.nombre,
          username: payload.usuario,
        },
      },
    });

    if (error) {
      throw error;
    }

    elements.registerForm.reset();
    clearMooglePrefill();
    setAuthView("login");
    elements.loginForm.elements.identifier.value = payload.correo;

    if (data.session) {
      showMessage(
        elements.applicationMessage,
        "success",
        "Cuenta creada y sesión iniciada. Tu perfil ya quedó conectado con Supabase."
      );
      return;
    }

    showMessage(
      elements.authMessage,
      "success",
      "Registro completado. Revisa tu correo para confirmar la cuenta antes de iniciar sesión."
    );
  } catch (error) {
    showMessage(elements.authMessage, "error", translateSupabaseError(error, "register"));
  } finally {
    setLoadingState(submitButton, false, "Registrarse");
  }
}

async function handleApplicationSubmit(event) {
  event.preventDefault();
  clearFieldErrors(elements.applicationForm);
  clearMessage(elements.applicationMessage);

  if (!appState.user) {
    showMessage(elements.applicationMessage, "error", "Debes iniciar sesión antes de enviar una solicitud.");
    return;
  }

  const formData = new FormData(elements.applicationForm);
  const payload = buildApplicationPayload(formData);
  const errors = validateApplication(payload);

  if (Object.keys(errors).length > 0) {
    Object.entries(errors).forEach(([field, message]) => setFieldError(elements.applicationForm, field, message));
    showMessage(elements.applicationMessage, "error", "Completa los campos requeridos antes de enviar tu solicitud.");
    return;
  }

  const submitButton = elements.applicationForm.querySelector('button[type="submit"]');
  setLoadingState(submitButton, true, "Enviando...");

  let uploadedPhotoPath = null;

  try {
    uploadedPhotoPath = await uploadOptionalAsset(payload.documents.applicantPhoto, appState.user.id, "photo");
    const record = buildApplicationRecord(payload, uploadedPhotoPath);

    const { error } = await supabaseClient
      .from(SUPABASE_CONFIG.applicationsTable)
      .insert(record);

    if (error) {
      throw error;
    }

    elements.applicationForm.reset();
    applyApplicationDefaults();

    showMessage(
      elements.applicationMessage,
      "success",
      "Solicitud enviada y almacenada en Supabase correctamente."
    );
  } catch (error) {
    if (uploadedPhotoPath) {
      await supabaseClient.storage.from(SUPABASE_CONFIG.assetsBucket).remove([uploadedPhotoPath]).catch(() => null);
    }

    showMessage(elements.applicationMessage, "error", translateSupabaseError(error, "application"));
  } finally {
    setLoadingState(submitButton, false, "Enviar solicitud");
  }
}

async function handleLogout() {
  clearMessage(elements.applicationMessage);

  const { error } = await supabaseClient.auth.signOut();

  if (error) {
    showMessage(elements.applicationMessage, "error", translateSupabaseError(error, "logout"));
  }
}

async function normalizeLoginIdentifier(identifier) {
  if (isValidEmail(identifier)) {
    return identifier.toLowerCase();
  }

  const { data, error } = await supabaseClient.rpc(SUPABASE_CONFIG.loginResolverRpc, {
    login_identifier: identifier,
  });

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("No existe una cuenta asociada a ese usuario.");
  }

  return String(data).toLowerCase();
}

async function ensureProfileForUser(user) {
  return upsertProfileFromUser(user);
}

async function fetchProfileByUserId(userId) {
  const { data, error } = await supabaseClient
    .from(SUPABASE_CONFIG.profilesTable)
    .select("id, user_id, full_name, username, email, avatar_url, auth_provider, raw_profile")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function upsertProfileFromUser(user) {
  const username =
    String(user.user_metadata?.username || "").trim() ||
    `user_${String(user.id).slice(0, 8)}`;

  const fullName =
    String(user.user_metadata?.full_name || "").trim() ||
    String(user.email || "").split("@")[0] ||
    "Candidato";
  const avatarUrl = String(user.user_metadata?.avatar_url || user.user_metadata?.picture || "").trim() || null;
  const authProvider = getAuthProvider(user);
  const rawProfile = user.user_metadata || {};

  const { data, error } = await supabaseClient
    .from(SUPABASE_CONFIG.profilesTable)
    .upsert(
      {
        user_id: user.id,
        full_name: fullName,
        username,
        email: user.email,
        avatar_url: avatarUrl,
        auth_provider: authProvider,
        raw_profile: rawProfile,
      },
      {
        onConflict: "user_id",
      }
    )
    .select("id, user_id, full_name, username, email, avatar_url, auth_provider, raw_profile")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

function buildFallbackProfile(user) {
  return {
    full_name:
      String(user.user_metadata?.full_name || "").trim() ||
      String(user.email || "").split("@")[0] ||
      "Candidato",
    username: String(user.user_metadata?.username || "").trim(),
    email: user.email || "",
    avatar_url: String(user.user_metadata?.avatar_url || user.user_metadata?.picture || "").trim(),
    auth_provider: getAuthProvider(user),
    raw_profile: user.user_metadata || {},
  };
}

function buildApplicationPayload(formData) {
  const applicantPhoto = formData.get("applicantPhoto");

  return {
    requestInfo: {
      applicationDate: getTrimmed(formData, "applicationDate"),
      desiredPosition: getTrimmed(formData, "desiredPosition"),
      desiredSalary: getTrimmed(formData, "desiredSalary"),
    },
    personalInfo: {
      surnamePaternal: getTrimmed(formData, "surnamePaternal"),
      surnameMaternal: getTrimmed(formData, "surnameMaternal"),
      firstNames: getTrimmed(formData, "firstNames"),
      age: getTrimmed(formData, "age"),
      address: getTrimmed(formData, "address"),
      colony: getTrimmed(formData, "colony"),
      postalCode: getTrimmed(formData, "postalCode"),
      phone: getTrimmed(formData, "phone"),
      mobile: getTrimmed(formData, "mobile"),
      birthPlace: getTrimmed(formData, "birthPlace"),
      birthDate: getTrimmed(formData, "birthDate"),
      nationality: getTrimmed(formData, "nationality"),
      sex: getTrimmed(formData, "sex"),
      livesWith: formData.getAll("livesWith").map((item) => String(item).trim()).filter(Boolean),
      dependents: formData.getAll("dependents").map((item) => String(item).trim()).filter(Boolean),
      height: getTrimmed(formData, "height"),
      weight: getTrimmed(formData, "weight"),
      maritalStatus: getTrimmed(formData, "maritalStatus"),
    },
    documentation: {
      curpNumber: getTrimmed(formData, "curpNumber"),
      militaryCardNumber: getTrimmed(formData, "militaryCardNumber"),
      passportNumber: getTrimmed(formData, "passportNumber"),
      driverLicense: getTrimmed(formData, "driverLicense"),
      driverLicenseTypeNumber: getTrimmed(formData, "driverLicenseTypeNumber"),
      foreignerWorkPermit: getTrimmed(formData, "foreignerWorkPermit"),
    },
    habits: {
      healthStatus: getTrimmed(formData, "healthStatus"),
      chronicDiseaseOption: getTrimmed(formData, "chronicDiseaseOption"),
      chronicDiseaseDetails: getTrimmed(formData, "chronicDiseaseDetails"),
      practicesSport: getTrimmed(formData, "practicesSport"),
      favoriteHobby: getTrimmed(formData, "favoriteHobby"),
    },
    family: {
      father: {
        name: getTrimmed(formData, "fatherName"),
        status: getTrimmed(formData, "fatherStatus"),
        address: getTrimmed(formData, "fatherAddress"),
        occupation: getTrimmed(formData, "fatherOccupation"),
      },
      mother: {
        name: getTrimmed(formData, "motherName"),
        status: getTrimmed(formData, "motherStatus"),
        address: getTrimmed(formData, "motherAddress"),
        occupation: getTrimmed(formData, "motherOccupation"),
      },
      spouse: {
        name: getTrimmed(formData, "spouseName"),
        status: getTrimmed(formData, "spouseStatus"),
        address: getTrimmed(formData, "spouseAddress"),
        occupation: getTrimmed(formData, "spouseOccupation"),
      },
      children: {
        names: getTrimmed(formData, "childrenNames"),
        address: getTrimmed(formData, "childrenAddress"),
        occupation: getTrimmed(formData, "childrenOccupation"),
      },
    },
    educationRecords: [
      buildEducationEntry(formData, "Primary", "Primaria"),
      buildEducationEntry(formData, "Secondary", "Secundaria"),
      buildEducationEntry(formData, "HighSchool", "Preparatoria o vocacional"),
      buildEducationEntry(formData, "Professional", "Profesional"),
      buildEducationEntry(formData, "Other", "Comercial u otras"),
    ],
    documents: {
      applicantPhoto: applicantPhoto instanceof File && applicantPhoto.name ? applicantPhoto : null,
    },
    declarationAccepted: formData.get("declaration") === "on",
    candidate: {
      authUserId: appState.user?.id || null,
      email: appState.user?.email || null,
      username: appState.profile?.username || appState.user?.user_metadata?.username || null,
    },
    submittedAt: new Date().toISOString(),
  };
}

function buildApplicationRecord(payload, photoPath) {
  const fullName = fullNameFromPayload(payload.personalInfo);
  const mainEducation = getFirstNonEmptyEducationRecord(payload.educationRecords);

  return {
    user_id: appState.user.id,
    application_date: payload.requestInfo.applicationDate,
    desired_position: payload.requestInfo.desiredPosition,
    desired_salary: payload.requestInfo.desiredSalary,
    photo_file_name: payload.documents.applicantPhoto?.name || null,
    photo_file_path: photoPath,
    photo_file_size: payload.documents.applicantPhoto?.size || null,
    photo_file_type: payload.documents.applicantPhoto?.type || null,
    full_name: fullName,
    age: toNullableInt(payload.personalInfo.age),
    birth_date: payload.personalInfo.birthDate,
    sex: payload.personalInfo.sex,
    marital_status: payload.personalInfo.maritalStatus,
    phone: payload.personalInfo.phone,
    mobile: payload.personalInfo.mobile,
    personal_data: payload.personalInfo,
    documentation: payload.documentation,
    habits: payload.habits,
    family_data: payload.family,
    education_records: payload.educationRecords,
    primary_contact_address: payload.personalInfo.address,
    main_school_name: mainEducation?.schoolName || null,
    main_school_level: mainEducation?.level || null,
    declaration_accepted: payload.declarationAccepted,
    status: "submitted",
    submitted_at: payload.submittedAt,
    payload,
  };
}

async function uploadOptionalAsset(file, userId, folder) {
  if (!(file instanceof File) || !file.name) {
    return null;
  }

  const safeName = sanitizeFilename(file.name);
  const filePath = `${userId}/${folder}/${Date.now()}-${safeName}`;

  const { data, error } = await supabaseClient.storage
    .from(SUPABASE_CONFIG.assetsBucket)
    .upload(filePath, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "application/octet-stream",
    });

  if (error) {
    throw error;
  }

  return data.path;
}

function validateRegistration(payload, confirmPassword) {
  const errors = {};

  if (!payload.nombre) errors.nombre = "El nombre completo es obligatorio.";
  if (!payload.usuario) errors.usuario = "El usuario es obligatorio.";
  if (!payload.correo) errors.correo = "El correo es obligatorio.";
  if (payload.correo && !isValidEmail(payload.correo)) errors.correo = "Ingresa un correo válido.";
  if (!payload.password) errors.password = "La contraseña es obligatoria.";
  if (payload.password && payload.password.length < 6) {
    errors.password = "Usa una contraseña de al menos 6 caracteres.";
  }
  if (!confirmPassword) errors.confirmPassword = "Confirma tu contraseña.";
  if (payload.password && confirmPassword && payload.password !== confirmPassword) {
    errors.confirmPassword = "Las contraseñas no coinciden.";
  }

  return errors;
}

function validateApplication(payload) {
  const errors = {};

  if (!payload.requestInfo.applicationDate) errors.applicationDate = "Indica la fecha de la solicitud.";
  if (!payload.requestInfo.desiredPosition) errors.desiredPosition = "Indica el puesto solicitado.";
  if (!payload.requestInfo.desiredSalary) errors.desiredSalary = "Indica el sueldo deseado.";

  if (!payload.personalInfo.surnamePaternal) errors.surnamePaternal = "Ingresa el apellido paterno.";
  if (!payload.personalInfo.surnameMaternal) errors.surnameMaternal = "Ingresa el apellido materno.";
  if (!payload.personalInfo.firstNames) errors.firstNames = "Ingresa los nombres.";
  if (!payload.personalInfo.age) errors.age = "Ingresa la edad.";
  if (!payload.personalInfo.address) errors.address = "Ingresa el domicilio.";
  if (!payload.personalInfo.colony) errors.colony = "Ingresa la colonia.";
  if (!payload.personalInfo.postalCode) errors.postalCode = "Ingresa el código postal.";
  if (!payload.personalInfo.phone && !payload.personalInfo.mobile) {
    errors.phone = "Ingresa al menos un teléfono o móvil.";
  }
  if (!payload.personalInfo.birthPlace) errors.birthPlace = "Ingresa el lugar de nacimiento.";
  if (!payload.personalInfo.birthDate) errors.birthDate = "Ingresa la fecha de nacimiento.";
  if (!payload.personalInfo.nationality) errors.nationality = "Ingresa la nacionalidad.";
  if (!payload.personalInfo.sex) errors.sex = "Selecciona el sexo.";
  if (payload.personalInfo.livesWith.length === 0) errors.livesWith = "Selecciona con quién vive.";
  if (!payload.personalInfo.height) errors.height = "Ingresa la estatura.";
  if (!payload.personalInfo.weight) errors.weight = "Ingresa el peso.";
  if (!payload.personalInfo.maritalStatus) errors.maritalStatus = "Selecciona el estado civil.";

  if (!payload.documentation.curpNumber) errors.curpNumber = "Ingresa el CURP.";
  if (!payload.documentation.driverLicense) errors.driverLicense = "Indica si cuenta con licencia de manejo.";
  if (
    payload.documentation.driverLicense === "Sí" &&
    !payload.documentation.driverLicenseTypeNumber
  ) {
    errors.driverLicenseTypeNumber = "Indica el tipo y número de licencia.";
  }

  if (!payload.habits.healthStatus) errors.healthStatus = "Selecciona el estado de salud.";
  if (!payload.habits.chronicDiseaseOption) {
    errors.chronicDiseaseOption = "Indica si padece una enfermedad crónica.";
  }
  if (
    payload.habits.chronicDiseaseOption === "Sí" &&
    !payload.habits.chronicDiseaseDetails
  ) {
    errors.chronicDiseaseDetails = "Describe la enfermedad crónica.";
  }
  if (!payload.habits.practicesSport) errors.practicesSport = "Indica si practica algún deporte.";
  if (!payload.habits.favoriteHobby) errors.favoriteHobby = "Indica el pasatiempo favorito.";

  if (!payload.family.father.name) errors.fatherName = "Ingresa el nombre del padre.";
  if (!payload.family.father.status) errors.fatherStatus = "Selecciona el estado del padre.";
  if (!payload.family.father.address) errors.fatherAddress = "Ingresa el domicilio del padre.";
  if (!payload.family.father.occupation) errors.fatherOccupation = "Ingresa la ocupación del padre.";
  if (!payload.family.mother.name) errors.motherName = "Ingresa el nombre de la madre.";
  if (!payload.family.mother.status) errors.motherStatus = "Selecciona el estado de la madre.";
  if (!payload.family.mother.address) errors.motherAddress = "Ingresa el domicilio de la madre.";
  if (!payload.family.mother.occupation) errors.motherOccupation = "Ingresa la ocupación de la madre.";

  if (!payload.educationRecords.some((record) => record.schoolName)) {
    errors.educationRecords = "Ingresa al menos un registro de escolaridad.";
  }

  if (!payload.declarationAccepted) errors.declaration = "Debes confirmar la veracidad de la información.";

  return errors;
}

function translateSupabaseError(error, context) {
  const message = String(error?.message || error || "").trim();

  if (message.includes("Invalid login credentials")) {
    return "Las credenciales no son válidas.";
  }

  if (message.includes("Email not confirmed")) {
    return "Debes confirmar tu correo antes de iniciar sesión.";
  }

  if (message.includes("User already registered")) {
    return "Ese correo ya está registrado.";
  }

  if (message.includes("duplicate key value") && message.includes("profiles_username")) {
    return "Ese usuario ya está en uso.";
  }

  if (message.includes("duplicate key value") && message.includes("profiles_email")) {
    return "Ese correo ya está vinculado a otro perfil.";
  }

  if (message.includes("schema cache") || message.includes("Could not find the table")) {
    return "Falta ejecutar `supabase-setup.sql` en tu proyecto de Supabase.";
  }

  if (message.includes("Could not find the function") || message.includes(SUPABASE_CONFIG.loginResolverRpc)) {
    return "Falta crear la función `resolve_login_email`. Ejecuta `supabase-setup.sql`.";
  }

  if (message.includes("Bucket not found")) {
    return "El bucket de archivos no existe todavía. Ejecuta `supabase-setup.sql` para crearlo.";
  }

  if (context === "application" && message) {
    return `No se pudo guardar la solicitud en Supabase: ${message}`;
  }

  if (context === "register" && message) {
    return `No se pudo completar el registro: ${message}`;
  }

  if (context === "login" && message) {
    return `No se pudo iniciar sesión: ${message}`;
  }

  if (context === "logout" && message) {
    return `No se pudo cerrar la sesión: ${message}`;
  }

  return message || "Ocurrió un error inesperado al comunicarse con Supabase.";
}

function setFieldError(form, fieldName, message) {
  const fieldWrapper = form.querySelector(`[data-field="${fieldName}"]`);
  const errorElement = form.querySelector(`[data-error-for="${fieldName}"]`);

  if (fieldWrapper) {
    fieldWrapper.classList.add("field-invalid");
  }

  if (errorElement) {
    errorElement.textContent = message;
    errorElement.classList.remove("hidden");
  }
}

function clearFieldErrors(form) {
  form.querySelectorAll("[data-field]").forEach((field) => field.classList.remove("field-invalid"));
  form.querySelectorAll("[data-error-for]").forEach((errorElement) => {
    errorElement.textContent = "";
    errorElement.classList.add("hidden");
  });
}

function showMessage(element, type, message) {
  element.className = `form-message is-${type}`;
  element.textContent = message;
  element.classList.remove("hidden");
}

function clearMessage(element) {
  element.textContent = "";
  element.className = "form-message hidden";
}

function showSystemBanner(type, message) {
  elements.systemBanner.className = `mx-auto mb-8 max-w-7xl form-message is-${type}`;
  elements.systemBanner.textContent = message;
  elements.systemBanner.classList.remove("hidden");
}

function clearSystemBanner() {
  elements.systemBanner.textContent = "";
  elements.systemBanner.className = "mx-auto mb-8 hidden max-w-7xl form-message";
}

function setLoadingState(button, isLoading, label) {
  if (!button) return;

  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.innerHTML;
  }

  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
  button.innerHTML = isLoading
    ? `<i class="fa-solid fa-spinner fa-spin"></i>${label}`
    : button.dataset.defaultLabel;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getTrimmed(formData, fieldName) {
  return String(formData.get(fieldName) || "").trim();
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBooleanChoice(value) {
  return value === "Sí";
}

function applyApplicationDefaults() {
  if (!elements.applicationForm) return;

  const applicationDateInput = elements.applicationForm.elements.applicationDate;
  const firstNamesInput = elements.applicationForm.elements.firstNames;

  if (applicationDateInput && !applicationDateInput.value) {
    applicationDateInput.value = isoDateToday();
  }

  if (firstNamesInput && !firstNamesInput.value) {
    firstNamesInput.value =
      appState.profile?.full_name ||
      appState.user?.user_metadata?.full_name ||
      "";
  }
}

function buildEducationEntry(formData, key, level) {
  return {
    key,
    level,
    schoolName: getTrimmed(formData, `education${key}School`),
    address: getTrimmed(formData, `education${key}Address`),
    startDate: getTrimmed(formData, `education${key}StartDate`),
    endDate: getTrimmed(formData, `education${key}EndDate`),
    certificate: getTrimmed(formData, `education${key}Certificate`),
  };
}

function getFirstNonEmptyEducationRecord(records) {
  return records.find(
    (record) => record.schoolName || record.address || record.startDate || record.endDate || record.certificate
  );
}

function fullNameFromPayload(personalInfo) {
  return [
    personalInfo.surnamePaternal,
    personalInfo.surnameMaternal,
    personalInfo.firstNames,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function toNullableInt(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isoDateToday() {
  return new Date().toISOString().slice(0, 10);
}

function getAuthProvider(user) {
  return String(user?.app_metadata?.provider || "email").trim();
}

function sanitizeFilename(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");
}

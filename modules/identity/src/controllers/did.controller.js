
/**
 * DID controller: transport only. Serves DID documents (the homing pointer)
 * for identity resolution — cross-hub identity serving on the V1 registry
 * method resolves here (ac-9).
 */
export class DidController {
  /**
   * @param {import("didService").DidService} didService
   */
  constructor(didService) {
    this.didService = didService;
  }

  /** GET /did/:did — the DID document of a homed identity. */
  getDocument = async (req, res) => {
    const did = req.params.did;
    if (!did) return res.status(400).json({ error: "did required", code: "E_FIELDS_REQUIRED" });
    const document = await this.didService.getDocument(did);
    if (!document) return res.status(404).json({ error: "identity not found on this hub", code: "E_DID_NOT_FOUND" });
    res.type("application/did+json").json(document);
  };
}

export default DidController;